import { app, BrowserWindow, globalShortcut, ipcMain, Notification, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineClient } from './engine-client.js'
import { engineBaseUrl, EngineSidecar, findFreePort } from './engine-sidecar.js'
import { loadConfig, type DesktopConfig } from './config.js'
import { DesktopPoller } from './poller.js'
import { TrayController } from './tray.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const PRELOAD_PATH = join(here, '../preload/index.cjs')
const PROTOCOL = 'rerun'
const BOOT_TIMEOUT_MS = Number.parseInt(process.env.DESKTOP_ENGINE_BOOT_TIMEOUT_MS ?? '90000', 10)

let mainWindow: BrowserWindow | null = null
let config: DesktopConfig
let tray: TrayController
let poller: DesktopPoller
let quitting = false
let pendingDeepLink: string | null = null
let pendingDictation = false

function log(message: string): void {
    console.log(`[desktop-app] ${message}`)
}

function uiOrigin(): string {
    return new URL(config.uiUrl).origin
}

function deeplinkToPath(raw: string): string | null {
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return null
    }
    if (url.protocol !== `${PROTOCOL}:`) return null
    const path = `/${[url.host, url.pathname].filter(Boolean).join('/')}`
    const normalized = path.replace(/\/+/g, '/')
    return `${normalized === '/' ? '/' : normalized}${url.search}`
}

function navigateToPath(path: string): void {
    const target = new URL(path, config.uiUrl)
    if (target.origin !== uiOrigin()) {
        log(`ignoring deep link outside UI origin: ${target.origin}`)
        return
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
        pendingDeepLink = target.toString()
        return
    }
    mainWindow.show()
    mainWindow.focus()
    void mainWindow.loadURL(target.toString())
    mainWindow.webContents.send('desktop:navigate', path)
}

function handleDeepLink(raw: string): void {
    const path = deeplinkToPath(raw)
    if (path) {
        log(`deep link: ${raw} -> ${path}`)
        navigateToPath(path)
    }
}

function showWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
}

function notify(title: string, body: string): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body })
    notification.on('click', () => showWindow())
    notification.show()
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: 'Rerun',
        backgroundColor: '#0b0b0f',
        webPreferences: {
            preload: PRELOAD_PATH,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    })

    mainWindow.on('close', event => {
        if (!quitting) {
            event.preventDefault()
            mainWindow?.hide()
        }
    })
    mainWindow.on('closed', () => {
        mainWindow = null
    })

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith(`${uiOrigin()}/`) || url === config.uiUrl) return { action: 'allow' }
        if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
        return { action: 'deny' }
    })

    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith(`${PROTOCOL}://`)) {
            event.preventDefault()
            handleDeepLink(url)
            return
        }
        try {
            if (new URL(url).origin !== uiOrigin()) {
                event.preventDefault()
                void shell.openExternal(url)
            }
        } catch {
            event.preventDefault()
        }
    })

    mainWindow.webContents.on('did-finish-load', () => {
        log(`window loaded ${mainWindow?.webContents.getURL() ?? 'unknown'}`)
        if (pendingDictation) {
            pendingDictation = false
            mainWindow?.webContents.send('desktop:dictation')
        }
    })
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
        log(`window failed to load: ${code} ${description}`)
    })

    const initialUrl = pendingDeepLink ?? config.uiUrl
    pendingDeepLink = null
    void mainWindow.loadURL(initialUrl)
    log(`window loading ${initialUrl}`)
}

async function bootstrap(): Promise<void> {
    const userDataDir = app.getPath('userData')
    config = loadConfig(userDataDir)
    log(`config: ui=${config.uiUrl} enginePort=${config.enginePort} dataDir=${config.engineDataDir}`)

    app.setAsDefaultProtocolClient(PROTOCOL)

    const port = await findFreePort(config.enginePort)
    if (port !== config.enginePort) {
        log(`engine port ${config.enginePort} busy, using ${port}`)
        config.enginePort = port
    }
    const baseUrl = engineBaseUrl(port)

    let sidecarState = 'starting'
    const sidecar = new EngineSidecar({
        config,
        healthUrl: `${baseUrl}/health`,
        bootTimeoutMs: BOOT_TIMEOUT_MS,
        onState: state => {
            sidecarState = state
            log(`engine state: ${state}`)
            tray?.setEngineState(state)
        },
        onLog: line => console.log(line),
    })

    tray = new TrayController(() => showWindow())
    createWindow()

    if (config.pttAccelerator) {
        const registered = globalShortcut.register(config.pttAccelerator, () => {
            showWindow()
            if (!mainWindow || mainWindow.webContents.isLoading()) {
                pendingDictation = true
                return
            }
            mainWindow.webContents.send('desktop:dictation')
        })
        log(`push-to-talk ${registered ? `registered on ${config.pttAccelerator}` : `FAILED to register ${config.pttAccelerator}`}`)
    }

    const client = new EngineClient(baseUrl, config.engineApiKey)
    poller = new DesktopPoller({
        client,
        intervalMs: config.pollIntervalMs,
        onApprovalCount: count => tray.setApprovalCount(count),
        onEngineReachable: reachable => {
            if (sidecarState === 'ready') tray.setEngineState(reachable ? 'ready' : 'restarting')
        },
        notify,
    })
    poller.start()

    ipcMain.handle('desktop:engine-status', () => ({
        state: sidecar.currentState,
        engineUrl: baseUrl,
        uiUrl: config.uiUrl,
        pendingApprovals: tray.pendingApprovals,
    }))

    void sidecar.start()

    app.on('before-quit', event => {
        if (quitting) return
        quitting = true
        event.preventDefault()
        log('quitting: stopping poller and engine sidecar')
        globalShortcut.unregisterAll()
        poller?.stop()
        void sidecar.stop().finally(() => app.quit())
    })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
    app.quit()
} else {
    app.on('second-instance', (_event, argv) => {
        showWindow()
        const link = argv.find(arg => arg.startsWith(`${PROTOCOL}://`))
        if (link) handleDeepLink(link)
    })

    app.on('open-url', (event, url) => {
        event.preventDefault()
        handleDeepLink(url)
    })

    app.on('window-all-closed', () => {
        // Tray app: closing the window hides it; quit happens via the tray menu.
    })

    app.on('activate', () => showWindow())

    app.whenReady().then(() => bootstrap().catch(err => {
        console.error('[desktop-app] bootstrap failed:', err)
        app.quit()
    }))
}

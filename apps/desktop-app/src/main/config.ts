import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DesktopConfig {
    uiUrl: string
    enginePort: number
    engineApiKey: string
    engineDataDir: string
    pollIntervalMs: number
}

const CONFIG_FILE = 'desktop-config.json'

function envOr(name: string, fallback: string): string {
    const value = process.env[name]
    return value && value.length > 0 ? value : fallback
}

export function defaultUiUrl(): string {
    return envOr('DESKTOP_UI_URL', envOr('RERUN_UI_URL', 'http://localhost:3050'))
}

export function defaultEngineDataDir(): string {
    return envOr('DESKTOP_ENGINE_DATA_DIR', envOr('RERUN_DATA_DIR', join(homedir(), '.rerun')))
}

export function defaultEnginePort(): number {
    const raw = process.env.DESKTOP_ENGINE_PORT
    const port = raw ? Number.parseInt(raw, 10) : 3051
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 3051
}

export function defaultPollIntervalMs(): number {
    const raw = process.env.DESKTOP_POLL_INTERVAL_MS
    const ms = raw ? Number.parseInt(raw, 10) : 15_000
    return Number.isInteger(ms) && ms >= 2_000 ? ms : 15_000
}

export function loadConfig(userDataDir: string): DesktopConfig {
    const file = join(userDataDir, CONFIG_FILE)
    let stored: Partial<DesktopConfig> = {}
    if (existsSync(file)) {
        try {
            stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopConfig>
        } catch {
            stored = {}
        }
    }
    const envUiUrl = process.env.DESKTOP_UI_URL ?? process.env.RERUN_UI_URL
    const envDataDir = process.env.DESKTOP_ENGINE_DATA_DIR ?? process.env.RERUN_DATA_DIR
    const envPort = process.env.DESKTOP_ENGINE_PORT
    const envPoll = process.env.DESKTOP_POLL_INTERVAL_MS
    const config: DesktopConfig = {
        uiUrl: envUiUrl || stored.uiUrl || 'http://localhost:3050',
        enginePort: envPort ? defaultEnginePort() : (stored.enginePort ?? defaultEnginePort()),
        engineApiKey: stored.engineApiKey ?? randomBytes(24).toString('base64url'),
        engineDataDir: envDataDir || stored.engineDataDir || join(homedir(), '.rerun'),
        pollIntervalMs: envPoll ? defaultPollIntervalMs() : (stored.pollIntervalMs ?? defaultPollIntervalMs()),
    }
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(file, JSON.stringify(config, null, 4))
    return config
}

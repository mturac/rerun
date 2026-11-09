import { app, Menu, nativeImage, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const ICON_PATH = resolve(here, '../../../ui/public/icon-192.png')

export type EngineTrayState = 'starting' | 'ready' | 'restarting' | 'stopped' | 'failed'

export class TrayController {
    private readonly tray: Tray
    private approvalCount = 0
    private engineState: EngineTrayState = 'starting'

    constructor(private readonly onShow: () => void) {
        this.tray = new Tray(this.loadIcon())
        this.tray.setToolTip('Rerun')
        this.rebuildMenu()
        this.tray.on('click', () => this.onShow())
    }

    private loadIcon(): Electron.NativeImage {
        if (existsSync(ICON_PATH)) {
            const image = nativeImage.createFromPath(ICON_PATH)
            if (!image.isEmpty()) {
                const resized = image.resize({ width: 18, height: 18 })
                if (process.platform === 'darwin') resized.setTemplateImage(true)
                return resized
            }
        }
        return nativeImage.createEmpty()
    }

    private rebuildMenu(): void {
        const menu = Menu.buildFromTemplate([
            { label: 'Open Rerun', click: () => this.onShow() },
            { type: 'separator' },
            { label: `Engine: ${this.engineState}`, enabled: false },
            { type: 'separator' },
            { label: 'Quit Rerun', click: () => app.quit() },
        ])
        this.tray.setContextMenu(menu)
    }

    get pendingApprovals(): number {
        return this.approvalCount
    }

    setEngineState(state: EngineTrayState): void {
        this.engineState = state
        this.rebuildMenu()
        this.updateTooltip()
    }

    setApprovalCount(count: number): void {
        this.approvalCount = count
        this.tray.setTitle(count > 0 ? String(count) : '')
        this.updateTooltip()
    }

    private updateTooltip(): void {
        const approvals = this.approvalCount > 0 ? ` — ${this.approvalCount} pending approval${this.approvalCount === 1 ? '' : 's'}` : ''
        this.tray.setToolTip(`Rerun — engine ${this.engineState}${approvals}`)
    }
}

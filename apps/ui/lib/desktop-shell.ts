export interface RerunDesktopShell {
    getEngineStatus: () => Promise<unknown>
    onNavigate: (callback: (path: string) => void) => () => void
    onDictation: (callback: () => void) => () => void
    platform: string
}

declare global {
    interface Window {
        rerunDesktopShell?: RerunDesktopShell
    }
}

export function onDesktopDictation(callback: () => void): (() => void) | null {
    return window.rerunDesktopShell?.onDictation(callback) ?? null
}

import type { IpcRendererEvent } from 'electron'

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

const api = {
    getEngineStatus: (): Promise<unknown> => ipcRenderer.invoke('desktop:engine-status'),
    onNavigate: (callback: (path: string) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, path: string) => callback(path)
        ipcRenderer.on('desktop:navigate', listener)
        return () => ipcRenderer.removeListener('desktop:navigate', listener)
    },
    onDictation: (callback: () => void): (() => void) => {
        const listener = () => callback()
        ipcRenderer.on('desktop:dictation', listener)
        return () => ipcRenderer.removeListener('desktop:dictation', listener)
    },
    platform: process.platform as string,
}

contextBridge.exposeInMainWorld('rerunDesktop', api)
contextBridge.exposeInMainWorld('rerunDesktopShell', api)

import type { IpcRendererEvent } from 'electron'

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

const api = {
    getEngineStatus: (): Promise<unknown> => ipcRenderer.invoke('desktop:engine-status'),
    onNavigate: (callback: (path: string) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, path: string) => callback(path)
        ipcRenderer.on('desktop:navigate', listener)
        return () => ipcRenderer.removeListener('desktop:navigate', listener)
    },
    platform: process.platform as string,
}

contextBridge.exposeInMainWorld('rerunDesktop', api)

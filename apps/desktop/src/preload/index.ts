import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('clinmeshDesktop', Object.freeze({ platform: process.platform }))

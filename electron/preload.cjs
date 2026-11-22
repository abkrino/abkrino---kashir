const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kashirAnnouncer', Object.freeze({
  list: () => ipcRenderer.invoke('announcer:list'),
  create: (payload) => ipcRenderer.invoke('announcer:create', payload),
  readAudio: (id) => ipcRenderer.invoke('announcer:audio', id),
  remove: (id) => ipcRenderer.invoke('announcer:delete', id)
}));

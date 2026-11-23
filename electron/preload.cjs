const { contextBridge, ipcRenderer } = require('electron');

const machineId = ipcRenderer.sendSync('system:get-machine-id');
contextBridge.exposeInMainWorld('electronAPI', Object.freeze({
  getMachineId: () => machineId
}));
contextBridge.exposeInMainWorld('kashirAnnouncer', Object.freeze({
  list: () => ipcRenderer.invoke('announcer:list'),
  create: (payload) => ipcRenderer.invoke('announcer:create', payload),
  cancel: () => ipcRenderer.invoke('announcer:cancel'),
  readAudio: (id) => ipcRenderer.invoke('announcer:audio', id),
  remove: (id) => ipcRenderer.invoke('announcer:delete', id)
}));

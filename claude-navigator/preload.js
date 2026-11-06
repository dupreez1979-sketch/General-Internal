// Bridges the folder tree page to the desktop app. Only these functions are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('navigatorApp', {
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openWindow: (url) => ipcRenderer.invoke('open-window', url),
  onShortcut: (fn) => ipcRenderer.on('shortcut', (_e, action) => fn(action)),
});

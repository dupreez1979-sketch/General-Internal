// Bridges the folder page to the desktop app. Only these functions are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('navigatorApp', {
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openWindow: (url) => ipcRenderer.invoke('open-window', url),
  showInFolder: (file) => ipcRenderer.invoke('show-in-folder', file),
  openFile: (file) => ipcRenderer.invoke('open-file', file),
  onShortcut: (fn) => ipcRenderer.on('shortcut', (_e, action) => fn(action)),
  onDownload: (fn) => ipcRenderer.on('download', (_e, info) => fn(info)),
  refreshLibrary: (opts) => ipcRenderer.invoke('library-refresh', opts),
  harvestPane: (webContentsId, kind) => ipcRenderer.invoke('harvest-pane', webContentsId, kind),
  onChildNavigated: (fn) => ipcRenderer.on('child-navigated', (_e, info) => fn(info)),
  onContextAction: (fn) => ipcRenderer.on('context-action', (_e, info) => fn(info)),
});

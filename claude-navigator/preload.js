// Bridges the folder page to the desktop app. Only these functions are exposed.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('navigatorApp', {
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openWindow: (url) => ipcRenderer.invoke('open-window', url),
  showInFolder: (file) => ipcRenderer.invoke('show-in-folder', file),
  openFile: (file) => ipcRenderer.invoke('open-file', file),
  onShortcut: (fn) => ipcRenderer.on('shortcut', (_e, action) => fn(action)),
  onDownload: (fn) => ipcRenderer.on('download', (_e, info) => fn(info)),
  refreshLibrary: (opts) => ipcRenderer.invoke('library-refresh', opts),
  deleteChats: (items) => ipcRenderer.invoke('claude-delete-chats', items),
  harvestPane: (webContentsId, kind) => ipcRenderer.invoke('harvest-pane', webContentsId, kind),
  onChildNavigated: (fn) => ipcRenderer.on('child-navigated', (_e, info) => fn(info)),
  // Folders on this computer
  fsStatus: () => ipcRenderer.invoke('fs-status'),
  fsEnable: (root) => ipcRenderer.invoke('fs-enable', root),
  fsDisable: () => ipcRenderer.invoke('fs-disable'),
  fsChooseRoot: () => ipcRenderer.invoke('fs-choose-root'),
  fsScan: () => ipcRenderer.invoke('fs-scan'),
  fsApply: (payload) => ipcRenderer.invoke('fs-apply', payload),
  fsOpen: (rel) => ipcRenderer.invoke('fs-open', rel),
  fsReveal: (rel) => ipcRenderer.invoke('fs-reveal', rel),
  fsAbs: (rel) => ipcRenderer.invoke('fs-abs', rel),
  fsNewFile: (kind, destRel, name) => ipcRenderer.invoke('fs-new-file', kind, destRel, name),
  fsImport: (paths, destRel) => ipcRenderer.invoke('fs-import', paths, destRel),
  onFsChanged: (fn) => ipcRenderer.on('fs-changed', () => fn()),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
  onContextAction: (fn) => ipcRenderer.on('context-action', (_e, info) => fn(info)),
});

// Claude Navigator desktop app.
// Left: your own folder tree (index.html). Right: the real claude.ai, signed in,
// shown in a <webview> so every Claude feature (projects, artifacts, connectors,
// Canva, design systems) works exactly as it does in the browser.

const {
  app, BrowserWindow, ipcMain, shell, Menu, clipboard, session, systemPreferences,
} = require('electron');
const path = require('path');
const fs = require('fs');

const isMac = process.platform === 'darwin';
const PARTITION = 'persist:claude'; // keeps you signed in between launches

// Present as a normal Chrome browser so sign-in pages treat the app like one.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s?Electron\/[\d.]+/i, '')
  .replace(/\s?claude-navigator\/[\d.]+/i, '');

let mainWindow = null;
const send = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
const isClaudeHost = (url) => {
  try { const h = new URL(url).hostname; return h === 'claude.ai' || h.endsWith('.claude.ai') || h.endsWith('.anthropic.com'); } catch (e) { return false; }
};

// ---------- Windows ----------
function childWindowOptions() {
  return {
    width: 1200,
    height: 850,
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  };
}

function openChildWindow(url) {
  const win = new BrowserWindow(childWindowOptions());
  win.loadURL(url);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 480,
    title: 'Claude Navigator',
    autoHideMenuBar: true,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',          // traffic lights sit inside the sidebar
          trafficLightPosition: { x: 16, y: 16 },
          vibrancy: 'sidebar',                    // frosted sidebar, like Finder
          visualEffectState: 'active',
          backgroundColor: '#00000000',
        }
      : { backgroundColor: '#f3f3f3' }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Links clicked in the folder page itself (not the Claude pane) go to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------- Right-click menus ----------
function contextMenuFor(contents, p) {
  const isMain = mainWindow && contents === mainWindow.webContents;
  const isPane = contents.getType() === 'webview';
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };

  // Spelling
  if (p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: s, click: () => contents.replaceMisspelling(s) });
    }
    if (!p.dictionarySuggestions.length) items.push({ label: 'No Guesses Found', enabled: false });
    items.push({ label: 'Learn Spelling', click: () => contents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    sep();
  }

  // Links
  if (p.linkURL && !isMain) {
    items.push({ label: 'Open Link', click: () => contents.loadURL(p.linkURL) });
    items.push({ label: 'Open Link in New Window', click: () => openChildWindow(p.linkURL) });
    items.push({ label: 'Open Link in Web Browser', click: () => shell.openExternal(p.linkURL) });
    items.push({ label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) });
    if (isPane) items.push({ label: 'Save Link to a Folder…', click: () => send('context-action', { action: 'save-link', url: p.linkURL, text: (p.linkText || '').trim() }) });
    sep();
  }

  // Images
  if (p.mediaType === 'image' && p.srcURL && !isMain) {
    items.push({ label: 'Copy Image', click: () => contents.copyImageAt(p.x, p.y) });
    items.push({ label: 'Save Image to Downloads', click: () => contents.downloadURL(p.srcURL) });
    sep();
  }

  // Text
  const f = p.editFlags;
  if (p.isEditable) {
    items.push({ role: 'undo', enabled: f.canUndo }, { role: 'redo', enabled: f.canRedo });
    sep();
    items.push({ role: 'cut', enabled: f.canCut }, { role: 'copy', enabled: f.canCopy }, { role: 'paste', enabled: f.canPaste });
    if (!isMain) items.push({ role: 'pasteAndMatchStyle', enabled: f.canPaste });
    items.push({ role: 'selectAll' });
    sep();
  } else if (p.selectionText && p.selectionText.trim()) {
    items.push({ role: 'copy' });
    if (isMac) items.push({ label: `Look Up “${p.selectionText.trim().slice(0, 24)}${p.selectionText.trim().length > 24 ? '…' : ''}”`, click: () => contents.showDefinitionForSelection() });
    sep();
  }

  // Page
  if (!isMain && !p.isEditable && !p.linkURL) {
    items.push({ label: 'Back', enabled: contents.canGoBack(), click: () => contents.goBack() });
    items.push({ label: 'Forward', enabled: contents.canGoForward(), click: () => contents.goForward() });
    items.push({ label: 'Reload', click: () => contents.reload() });
    sep();
    if (isPane) items.push({ label: 'Save Page to Folder', accelerator: 'CmdOrCtrl+S', click: () => send('shortcut', 'save') });
    if (isPane) items.push({ label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send('shortcut', 'find') });
    items.push({ label: 'Print or Save as PDF…', accelerator: 'CmdOrCtrl+P', click: () => contents.print() });
    items.push({ label: 'Open Page in Web Browser', click: () => shell.openExternal(contents.getURL()) });
  }

  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  return items;
}

// ---------- Every web page the app creates ----------
app.on('web-contents-created', (_event, contents) => {
  // Lock down the embedded Claude pane: no Node access, fixed session.
  contents.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.spellcheck = true;
    params.partition = PARTITION;
  });

  contents.on('context-menu', (_e, params) => {
    const items = contextMenuFor(contents, params);
    if (!items.length) return;
    const host = contents.hostWebContents || contents;
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(host) || undefined });
  });

  if (contents.getType() !== 'webview') return;

  // Pop-ups from Claude (sign-in, connector authorisation, "open in new tab")
  // open in an app window that shares your Claude sign-in.
  contents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: childWindowOptions() }));

  // Navigator shortcuts keep working while you are typing inside Claude.
  // (Preventing the key here also stops the menu bar firing it a second time.)
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const key = input.key.toLowerCase();
    const map = {
      n: input.shift ? 'new-folder' : 'new-chat',
      s: input.shift ? null : 'save',
      f: input.shift ? null : 'find',
      g: input.shift ? 'find-prev' : 'find-next',
      p: input.shift ? null : 'print',
      l: input.shift ? null : 'add-link',
      '[': 'back',
      ']': 'forward',
    };
    const action = map[key];
    if (action) {
      event.preventDefault();
      send('shortcut', action);
    }
  });
});

// ---------- Session: downloads and permissions ----------
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

function setUpSession() {
  const ses = session.fromPartition(PARTITION);

  // Files from Claude (artifacts, exports, images) go straight to Downloads, like Safari.
  ses.on('will-download', (_e, item) => {
    const target = uniquePath(app.getPath('downloads'), item.getFilename() || 'download');
    item.setSavePath(target);
    const name = path.basename(target);
    send('download', { state: 'started', name });
    item.once('done', (_ev, state) => {
      send('download', { state, name, path: target });
      if (state === 'completed' && isMac) app.dock.downloadFinished(target);
    });
  });

  // Let Claude use the microphone (voice mode), clipboard and notifications.
  const allowed = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'pointerLock']);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const url = details.requestingUrl || '';
    if (!allowed.has(permission)) return callback(false);
    if (permission === 'media' && !isClaudeHost(url)) return callback(false);
    if (permission === 'media' && isMac) {
      const wantsCamera = (details.mediaTypes || []).includes('video');
      const asks = [systemPreferences.askForMediaAccess('microphone')];
      if (wantsCamera) asks.push(systemPreferences.askForMediaAccess('camera'));
      return Promise.all(asks).then(r => callback(r.every(Boolean))).catch(() => callback(false));
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (!allowed.has(permission)) return false;
    return permission !== 'media' || isClaudeHost(origin);
  });
}

// ---------- Menu bar (Mac) ----------
function buildMenu() {
  if (!isMac) { Menu.setApplicationMenu(null); return; }
  const act = a => () => send('shortcut', a);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'Cmd+N', click: act('new-chat') },
        { label: 'New Folder', accelerator: 'Cmd+Shift+N', click: act('new-folder') },
        { label: 'Add Link…', accelerator: 'Cmd+L', click: act('add-link') },
        { type: 'separator' },
        { label: 'Save Page to Folder', accelerator: 'Cmd+S', click: act('save') },
        { type: 'separator' },
        { label: 'Print or Save as PDF…', accelerator: 'Cmd+P', click: act('print') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find',
          submenu: [
            { label: 'Find…', accelerator: 'Cmd+F', click: act('find') },
            { label: 'Find Next', accelerator: 'Cmd+G', click: act('find-next') },
            { label: 'Find Previous', accelerator: 'Cmd+Shift+G', click: act('find-prev') },
          ],
        },
        { type: 'separator' },
        { role: 'startSpeaking' }, { role: 'stopSpeaking' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'as Icons', accelerator: 'Cmd+1', click: act('view-icons') },
        { label: 'as List', accelerator: 'Cmd+2', click: act('view-list') },
        { type: 'separator' },
        { label: 'Reload Page', accelerator: 'Cmd+R', click: act('reload') },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Back', accelerator: 'Cmd+[', click: act('back') },
        { label: 'Forward', accelerator: 'Cmd+]', click: act('forward') },
        { label: 'Enclosing Folder', accelerator: 'Cmd+Up', click: act('up') },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

// ---------- Messages from the folder page ----------
const httpUrl = u => typeof u === 'string' && /^https?:\/\//i.test(u);
ipcMain.handle('open-external', (_e, url) => { if (httpUrl(url)) return shell.openExternal(url); });
ipcMain.handle('open-window', (_e, url) => { if (httpUrl(url)) openChildWindow(url); });
ipcMain.handle('show-in-folder', (_e, file) => {
  if (typeof file === 'string' && file.startsWith(app.getPath('downloads'))) shell.showItemInFolder(file);
});
ipcMain.handle('open-file', (_e, file) => {
  if (typeof file === 'string' && file.startsWith(app.getPath('downloads'))) return shell.openPath(file);
});

// ---------- Start ----------
// Only one copy of the app at a time; a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    setUpSession();
    buildMenu();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
}


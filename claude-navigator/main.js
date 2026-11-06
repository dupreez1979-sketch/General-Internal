// Claude Navigator desktop app.
// Left: your own folder tree (index.html). Right: the real claude.ai, signed in,
// shown in a <webview> so every Claude feature (projects, artifacts, connectors,
// Canva, design systems) works exactly as it does in the browser.

const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');

const isMac = process.platform === 'darwin';
const PARTITION = 'persist:claude'; // keeps you signed in between launches

// Present as a normal Chrome browser so sign-in pages treat the app like one.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s?Electron\/[\d.]+/i, '')
  .replace(/\s?claude-navigator\/[\d.]+/i, '');

let mainWindow = null;

function childWindowOptions() {
  return {
    width: 1200,
    height: 850,
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
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
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Links clicked in the folder tree page itself (not the Claude pane) go to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Lock down the embedded Claude pane: no Node access, fixed session.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    params.partition = PARTITION;
  });

  if (contents.getType() !== 'webview') return;

  // Pop-ups from Claude (sign-in, connector authorisation, "open in new tab")
  // open in an app window that shares your Claude sign-in.
  contents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: childWindowOptions() }));

  // Forward a few navigator shortcuts even while you are typing inside Claude.
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const key = input.key.toLowerCase();
    let action = null;
    if (key === 'n' && input.shift) action = 'new-folder';
    else if (key === 's' && !input.shift) action = 'save';
    else if (key === '[') action = 'back';
    else if (key === ']') action = 'forward';
    if (action && mainWindow) {
      event.preventDefault();
      mainWindow.webContents.send('shortcut', action);
    }
  });
});

ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
});
ipcMain.handle('open-window', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) openChildWindow(url);
});

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
    // On a Mac keep the standard menu bar (Edit menu gives Cmd+C, Cmd+V, Cmd+Q).
    if (!isMac) Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

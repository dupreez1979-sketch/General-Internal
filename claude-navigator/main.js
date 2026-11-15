// Claude Navigator desktop app.
// Left: your own folder tree (index.html). Right: the real claude.ai, signed in,
// shown in a <webview> so every Claude feature (projects, artifacts, connectors,
// Canva, design systems) works exactly as it does in the browser.

const {
  app, BrowserWindow, ipcMain, shell, Menu, clipboard, session, systemPreferences, webContents, dialog, net, screen, webFrameMain, safeStorage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { FolderSync } = require('./fsync');
const monday = require('./monday');
const accounts = require('./accounts');
const mailindex = require('./mailindex');
const maillog = require('./maillog');
const granola = require('./granola');

const isMac = process.platform === 'darwin';

// ---------- Startup log ----------
// What the app did as it opened and how long each step took, so a slow start can be traced. It holds step names and
// times only: no names, mail, files or sign-ins. Kept in memory; "Copy Startup Log" in the Help menu copies it.
const T0 = Date.now();
const startLog = [];
const mark = (what, ms) => { if (startLog.length >= 600) startLog.splice(200, 100); startLog.push(`${((Date.now() - T0) / 1000).toFixed(1).padStart(7)}s  ${what}${ms != null ? ` (${ms} ms)` : ''}`); };
const timed = (what, fn) => { const t = Date.now(); try { return fn(); } finally { mark(what, Date.now() - t); } };
let lastJob = '', lastBeat = Date.now();
// A heartbeat four times a second: when one arrives late, the app was frozen (the spinning wheel) for that long.
setInterval(() => {
  const now = Date.now(), late = now - lastBeat - 250; lastBeat = now;
  if (late > 600 && late < 15 * 60e3) mark(`FROZE for ${(late / 1000).toFixed(1)} s${lastJob ? ', last job started: ' + lastJob : ''}`);
}, 250).unref();
// Every job the window asks of the app is timed; the slow ones are written down by name.
const rawHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (ch, fn) => rawHandle(ch, (...a) => {
  const t = Date.now(); lastJob = ch; let r;
  try { r = fn(...a); } finally { const d = Date.now() - t; if (d > 250) mark(`job ${ch} held the app`, d); }
  if (r && typeof r.then === 'function') r.then(() => {}, () => {}).then(() => { const d = Date.now() - t; if (d > 3000) mark(`job ${ch} answered`, d); });
  return r;
});
ipcMain.handle('startup-log', e => (mainWindow && e.sender === mainWindow.webContents ? startLogText() : ''));
ipcMain.on('start-note', (e, text) => { if (mainWindow && e.sender === mainWindow.webContents) mark('window: ' + String(text).replace(/[^\w .,:()-]/g, '').slice(0, 120)); });
const counts = { reads: 0, writes: 0 };
const startLogText = () => [`Claude Navigator ${app.getVersion()} startup log, copied ${((Date.now() - T0) / 1000).toFixed(0)} s after opening`, `macOS ${process.getSystemVersion ? process.getSystemVersion() : ''}, ${process.arch}`, ...startLog, `folder read ${counts.reads} times and written ${counts.writes} times since opening`].join('\n');
const PARTITION = 'persist:claude'; // keeps you signed in between launches
// Passkeys (Face ID, Touch ID, security keys through the system) cannot work inside the app: Electron has no way
// to reach them, so a sign-in that asks for one (Microsoft's, for Clara) waits for ever. With passkey sign-in
// switched off here, sites offer their other ways straight away (password, Authenticator app, email code).
app.commandLine.appendSwitch('disable-blink-features', 'WebAuth');

// Present as a normal Chrome browser so sign-in pages treat the app like one.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s?Electron\/[\d.]+/i, '')
  .replace(/\s?claude-navigator\/[\d.]+/i, '');

let mainWindow = null;
const send = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
// Only ordinary web links ever go to the web browser (never file:, smb: or links that start other apps).
const httpUrl = u => typeof u === 'string' && /^https?:\/\//i.test(u);
const openInBrowser = u => { if (httpUrl(u)) shell.openExternal(u); };
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
  quitting = false;
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
  watchRealClicks(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mark('window made');
  mainWindow.webContents.once('dom-ready', () => mark('window page read'));
  mainWindow.webContents.once('did-finish-load', () => mark('window page loaded'));
  mainWindow.on('unresponsive', () => mark('WINDOW stopped responding'));
  mainWindow.on('responsive', () => mark('window responding again'));
  mainWindow.webContents.on('render-process-gone', (_e, d) => mark('WINDOW process gone: ' + (d && d.reason)));
  mainWindow.on('closed', () => { mainWindow = null; quitting = true; for (const w of appWindows.values()) { try { w.close(); } catch (e) { /* gone */ } } });
  mainWindow.webContents.once('did-finish-load', () => { const s = winState(); for (const k of Object.keys(APP_WINDOWS)) if (s[k] && s[k].open) setTimeout(() => openAppWindow(k), 600); });

  // Links clicked in the folder page itself (not the Claude pane) go to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: 'deny' };
  });
  // The folder page never turns into another page (for example if a link or file is dropped on it).
  const stay = (e, url) => { if (url !== mainWindow.webContents.getURL()) { e.preventDefault(); openInBrowser(url); } };
  mainWindow.webContents.on('will-navigate', stay);
  mainWindow.webContents.on('will-redirect', stay);
}

// ---------- An app in a window of its own ----------
// Mail, Calendar and Notes can each open in a separate window, to put on another screen. Where each one was (which
// screen, what size) is remembered, and so is which were open, so they come back the same next time.
// Such a window shows that one app only. It cannot change your folders or your team: only the main window writes
// those (see SOLO in index.html), so two windows can never overwrite each other's work.
const APP_WINDOWS = { mail: 'Mail', cal: 'Calendar', notes: 'Notes', cos: 'Chief of Staff', navigator: 'File Navigator', claude: 'Claude', monday: 'monday.com' };
const appWindows = new Map();
const winFile = () => path.join(app.getPath('userData'), 'windows.json');
const winState = () => { try { return JSON.parse(fs.readFileSync(winFile(), 'utf8')) || {}; } catch (e) { return {}; } };
function winSave(key, patch) { try { const s = winState(); s[key] = Object.assign({}, s[key], patch); fs.writeFileSync(winFile(), JSON.stringify(s)); } catch (e) { /* next time */ } }
function tellAppWindows() { send('app-windows', [...appWindows.keys()]); }
function openAppWindow(key) {
  if (!APP_WINDOWS[key]) return { ok: false };
  const have = appWindows.get(key);
  if (have && !have.isDestroyed()) { if (have.isMinimized()) have.restore(); have.focus(); return { ok: true, focused: true }; }
  // Back where it was, if that screen is still there; otherwise on the screen the pointer is on.
  const saved = (winState()[key] || {}).bounds;
  let bounds = null;
  if (saved && saved.width > 300 && saved.height > 200) {
    const d = screen.getDisplayMatching(saved).workArea;
    const seen = Math.max(0, Math.min(saved.x + saved.width, d.x + d.width) - Math.max(saved.x, d.x)) * Math.max(0, Math.min(saved.y + saved.height, d.y + d.height) - Math.max(saved.y, d.y));
    if (seen > 200 * 120) bounds = saved;
  }
  if (!bounds) { const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea; const w = Math.min(1280, d.width - 80), h = Math.min(860, d.height - 80); bounds = { x: Math.round(d.x + (d.width - w) / 2), y: Math.round(d.y + (d.height - h) / 2), width: w, height: h }; }
  const win = new BrowserWindow(Object.assign({}, bounds, {
    minWidth: 620, minHeight: 420, title: APP_WINDOWS[key], autoHideMenuBar: true,
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 }, vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000' } : { backgroundColor: '#f3f3f3' }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true, spellcheck: true },
  }));
  appWindows.set(key, win);
  watchRealClicks(win);
  win.loadFile(path.join(__dirname, 'index.html'), { query: { solo: key } });
  win.webContents.setWindowOpenHandler(({ url }) => { openInBrowser(url); return { action: 'deny' }; });
  const stay = (e, url) => { if (url !== win.webContents.getURL()) { e.preventDefault(); openInBrowser(url); } };
  win.webContents.on('will-navigate', stay); win.webContents.on('will-redirect', stay);
  let t = null;
  const keep = () => { clearTimeout(t); t = setTimeout(() => { if (!win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) winSave(key, { bounds: win.getBounds() }); }, 400); };
  win.on('moved', keep); win.on('resized', keep); win.on('move', keep); win.on('resize', keep);
  win.on('close', () => { clearTimeout(t); try { if (!win.isMinimized() && !win.isFullScreen()) winSave(key, { bounds: win.getBounds() }); } catch (e) { /* closing */ } if (!quitting) winSave(key, { open: false }); });
  win.on('closed', () => { if (appWindows.get(key) === win) appWindows.delete(key); tellAppWindows(); });
  winSave(key, { open: true });
  tellAppWindows();
  return { ok: true };
}
let quitting = false;
app.on('before-quit', () => { quitting = true; });
ipcMain.handle('app-window-open', (e, key) => (fromOwnWindow(e) ? openAppWindow(String(key)) : { ok: false }));
// A window for one thing (an email, a message being written, a meeting), opened where it was dropped: it can sit
// on another screen. It is one of the app's own windows, so the send lock watches it like the others.
let itemSeq = 0;
function openItemWindow(solo, itemJson, b) {
  if (!['mail', 'cal'].includes(solo) || typeof itemJson !== 'string' || itemJson.length > 20000) return { ok: false };
  try { JSON.parse(itemJson); } catch (e) { return { ok: false }; }
  const pt = b && Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: Math.round(b.x), y: Math.round(b.y) } : screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt).workArea;
  const w = Math.max(560, Math.min(d.width, Math.round((b && b.width) || 900))), h = Math.max(420, Math.min(d.height, Math.round((b && b.height) || 760)));
  const x = Math.max(d.x, Math.min(d.x + d.width - w, pt.x)), y = Math.max(d.y, Math.min(d.y + d.height - h, pt.y));
  const win = new BrowserWindow({ x, y, width: w, height: h, minWidth: 480, minHeight: 360, autoHideMenuBar: true,
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 }, backgroundColor: '#ffffff' } : { backgroundColor: '#f3f3f3' }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true, spellcheck: true } });
  const key = 'item:' + (++itemSeq);
  appWindows.set(key, win);
  watchRealClicks(win);
  win.loadFile(path.join(__dirname, 'index.html'), { query: { solo, item: itemJson } });
  win.webContents.setWindowOpenHandler(({ url }) => { openInBrowser(url); return { action: 'deny' }; });
  const stay = (e, url) => { if (url !== win.webContents.getURL()) { e.preventDefault(); openInBrowser(url); } };
  win.webContents.on('will-navigate', stay); win.webContents.on('will-redirect', stay);
  win.on('closed', () => { if (appWindows.get(key) === win) appWindows.delete(key); });
  return { ok: true };
}
ipcMain.handle('item-window-open', (e, solo, itemJson, b) => (fromOwnWindow(e) ? openItemWindow(String(solo), itemJson, b) : { ok: false }));
ipcMain.handle('app-window-list', () => [...appWindows.keys()]);
ipcMain.handle('app-window-main', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } return true; });

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
    items.push({ label: 'Open Link in Web Browser', click: () => openInBrowser(p.linkURL) });
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
    if (isPane) items.push({ label: 'Save As\u2026', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('shortcut', 'save-as') });
    if (isPane) items.push({ label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send('shortcut', 'find') });
    items.push({ label: 'Print or Save as PDF…', accelerator: 'CmdOrCtrl+P', click: () => contents.print() });
    items.push({ label: 'Open Page in Web Browser', click: () => openInBrowser(contents.getURL()) });
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

  contents.on('dom-ready', () => { tabKeepRestore(contents).then(() => setTimeout(() => tabKeepSnap(contents), 4000)).catch(() => {}); });
  contents.on('did-navigate-in-page', (_e, url) => { setTimeout(() => tabKeepSnap(contents), 1500); claraHome(contents, url); });
  contents.on('did-navigate', (_e, url) => claraHome(contents, url));

  if (contents.getType() !== 'webview') return;

  // Belt and braces for sign-in pages: if a page still asks for a passkey, answer "not available" at once,
  // so it moves on to another way to sign in instead of hanging.
  contents.on('dom-ready', () => {
    let host = '';
    try { host = new URL(contents.getURL()).hostname; } catch (e) { return; }
    if (!/(^|\.)(microsoftonline\.com|live\.com|microsoft\.com|google\.com|okta\.com|auth0\.com|apple\.com|icloud\.com)$/i.test(host)) return;
    contents.executeJavaScript(`(() => { try {
      const no = () => Promise.reject(new DOMException('Passkeys are not available in this app', 'NotAllowedError'));
      if (navigator.credentials) { navigator.credentials.get = no; navigator.credentials.create = no; }
      if (window.PublicKeyCredential) { window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false); window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false); }
    } catch (e) {} })()`).catch(() => {});
  });

  // Pop-ups from Claude (sign-in, connector authorisation, "open in new tab")
  // open in an app window that shares your Claude sign-in.
  contents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: childWindowOptions() }));

  // Tell the folder page where pop-up windows go, so a Doc or Slides that opens in its own
  // window can still be filed and named.
  contents.on('did-create-window', (win) => {
    const report = () => {
      if (win.isDestroyed()) return;
      send('child-navigated', { url: win.webContents.getURL(), title: win.webContents.getTitle() });
    };
    ['did-navigate', 'did-navigate-in-page', 'page-title-updated'].forEach(ev => win.webContents.on(ev, report));
  });

  // Navigator shortcuts keep working while you are typing inside Claude.
  // (Preventing the key here also stops the menu bar firing it a second time.)
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    // Show or hide the sidebar: Ctrl+Cmd+S on a Mac, Ctrl+Alt+S elsewhere.
    if (input.code === 'KeyS' && (isMac ? (input.control && input.meta && !input.alt) : (input.control && input.alt))) { event.preventDefault(); send('shortcut', 'toggle-side'); return; }
    // Talk to the Chief of Staff from anywhere: Ctrl+Shift+Space. Press again when you have finished.
    // (Not Cmd+Shift+Space: macOS can give that to Siri.)
    if (input.code === 'Space' && input.shift && input.control && !input.meta && !input.alt) { event.preventDefault(); send('shortcut', 'cos-talk'); return; }
    // Cmd+Option+0..9: switch profile, even while typing in Claude.
    if (input.alt) {
      const m = /^Digit([0-9])$/.exec(input.code || '');
      if (m) { event.preventDefault(); send('shortcut', 'profile-' + m[1]); }
      return;
    }
    const key = input.key.toLowerCase();
    const map = {
      n: input.shift ? 'new-folder' : 'new-chat',
      s: input.shift ? 'save-as' : 'save',
      f: input.shift ? null : 'find',
      g: input.shift ? 'find-prev' : 'find-next',
      p: input.shift ? null : 'print',
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

  // Let Claude (and only Claude) use the microphone (voice mode), clipboard and notifications.
  // Other sites opened from a chat get none of these, apart from going full screen.
  const allowed = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'pointerLock']);
  const anySite = new Set(['fullscreen', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const url = details.requestingUrl || '';
    if (!allowed.has(permission)) return callback(false);
    if (!anySite.has(permission) && !isClaudeHost(url)) return callback(false);
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
    return anySite.has(permission) || isClaudeHost(origin);
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
        { type: 'separator' },
        { label: 'Save Page to Folder', accelerator: 'Cmd+S', click: act('save') },
        { label: 'Save As\u2026', accelerator: 'Cmd+Shift+S', click: act('save-as') },
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
        { label: 'Claude Settings', accelerator: 'Cmd+Shift+,', click: act('claude-settings') },
        { label: 'Hide or Show Claude\u2019s Own Sidebar', click: act('toggle-claude-sidebar') },
        { type: 'separator' },
        { label: 'Show or Hide Sidebar', accelerator: 'Ctrl+Cmd+S', click: act('toggle-side') },
        { label: 'Show or Hide Claude', click: act('toggle-claude') },
        { label: 'Show or Hide Second List', click: act('toggle-split') },
        { label: 'Show or Hide Details (Chief of Staff)', click: act('toggle-detail') },
        { label: 'Put Panels Back as They Were', click: act('reset-frames') },
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
    {
      role: 'help',
      submenu: [
        { label: 'Run Checks', click: () => send('shortcut', 'run-checks') },
        { label: 'Copy Startup Log', click: () => { clipboard.writeText(startLogText()); send('shortcut', 'startlog-copied'); } },
      ],
    },
  ]));
}

// ---------- Claude Library: read your chats, projects and artifacts ----------
// Claude has no public API for this, so the app asks claude.ai the same way its own
// Recents page does, using your signed-in session. If that ever stops working, it
// falls back to reading the links Claude shows on its Recents and Artifacts pages.

const LIB_PATTERNS = {
  code: '^/code/session_[A-Za-z0-9_-]{6,}',
  chats: '^/chat/[0-9a-fA-F-]{8,}$',
  artifacts: '^/(artifact|artifacts|public/artifacts)/[^/]+',
};

// Runs inside a claude.ai page: returns [{ url, name }] for links matching a pattern.
const COLLECT_FN = `function (pattern) {
  const re = new RegExp(pattern);
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { continue; }
    if (u.origin !== location.origin || !re.test(u.pathname)) continue;
    const url = u.origin + u.pathname.replace(/\\/+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    const lines = (a.getAttribute('aria-label') || a.innerText || a.textContent || '')
      .split('\\n').map(s => s.trim()).filter(Boolean);
    // Anything else the card says about itself (for example "Slides" or "Doc"), to pick the right icon.
    const hints = [lines.slice(1).join(' '), a.getAttribute('title') || '', a.getAttribute('data-testid') || '']
      .concat([...a.querySelectorAll('[aria-label], img[alt], [title], [data-testid]')].slice(0, 12)
        .map(e => e.getAttribute('aria-label') || e.getAttribute('alt') || e.getAttribute('title') || e.getAttribute('data-testid') || ''));
    out.push({ url, name: (lines[0] || '').slice(0, 200), meta: hints.join(' ').replace(/\\s+/g, ' ').slice(0, 300) });
  }
  return out;
}`;

// Scrolls a claude.ai list page to the bottom (clicking "Show more") while collecting links.
const scrollHarvest = (pattern) => `(async () => {
  const collect = ${COLLECT_FN};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const found = new Map();
  let stable = 0;
  // Waits at least ~7 seconds and for the list to stop growing, so a slow page is read in full.
  for (let i = 0; i < 90 && stable < 6; i++) {
    const before = found.size;
    for (const x of collect(${JSON.stringify(pattern)})) {
      const prev = found.get(x.url);
      if (!prev || (!prev.name && x.name)) found.set(x.url, x);
    }
    for (const b of document.querySelectorAll('button')) {
      if (/^(show|load|view) (more|all)/i.test((b.innerText || '').trim())) b.click();
    }
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
    }
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(700);
    if (found.size !== before) stable = 0;
    else if (i >= 10 && (found.size > 0 || i > 18)) stable++;
  }
  return [...found.values()];
})()`;

// Asks claude.ai for the full lists, as its own pages do.
const API_SCRIPT = `(async () => {
  const out = { chats: [], projects: [], notes: [], status: 0, chatsComplete: true };
  const get = async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) { out.status = r.status; throw new Error(u.split('?')[0] + ' answered ' + r.status); }
    return r.json();
  };
  const list = (x) => Array.isArray(x) ? x : (x && (x.data || x.conversations || x.projects || x.items)) || [];
  try {
    const orgs = list(await get('/api/organizations'));
    for (const o of orgs) {
      if (!o || !o.uuid) continue;
      const seen = new Set();
      try {
        for (let off = 0, n = 0; n < 50; n++, off += 200) {
          const page = list(await get('/api/organizations/' + o.uuid + '/chat_conversations?limit=200&offset=' + off));
          const fresh = page.filter(c => c && c.uuid && !seen.has(c.uuid));
          fresh.forEach(c => seen.add(c.uuid));
          for (const c of fresh) out.chats.push({
            name: c.name || 'Untitled chat',
            url: 'https://claude.ai/chat/' + c.uuid,
            updated: c.updated_at || c.created_at || null,
            created: c.created_at || null,
            starred: !!c.is_starred,
            org: o.uuid,
          });
          if (page.length < 200 || !fresh.length) break;
        }
      } catch (e) { out.notes.push('chats: ' + e.message); out.chatsComplete = false; }
      try {
        for (const p of list(await get('/api/organizations/' + o.uuid + '/projects'))) {
          if (p && p.uuid) out.projects.push({ name: p.name || 'Untitled project', url: 'https://claude.ai/project/' + p.uuid, updated: p.updated_at || p.created_at || null });
        }
      } catch (e) { out.notes.push('projects: ' + e.message); }
    }
  } catch (e) { out.notes.push(e.message); out.chatsComplete = false; }
  out.chats.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  out.projects.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  return out;
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Finds the address of one of Claude's own pages (for example "Scheduled") from its navigation links.
const discoverPage = (labelPattern) => `(() => {
  const re = new RegExp(${JSON.stringify(labelPattern)}, 'i');
  for (const a of document.querySelectorAll('a[href]')) {
    const t = [(a.innerText || '').split('\\n')[0], a.getAttribute('aria-label') || '', a.getAttribute('title') || ''].map(s => s.trim());
    if (!t.some(x => re.test(x))) continue;
    let u;
    try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { continue; }
    if (u.origin === location.origin && u.pathname.length > 1) return u.pathname.replace(/\\/+$/, '');
  }
  return null;
})()`;

// Opens a Claude page in a hidden window. Returns false if Claude's security check ("Just a moment")
// never finished, so that is not mistaken for being signed out.
async function openHidden(win, url) {
  await win.loadURL(url).catch(() => {}); // redirects can reject; the page still loads
  let cleared = false;
  for (let i = 0; i < 40 && !win.isDestroyed(); i++) {
    if (!/just a moment|checking your browser/i.test(win.webContents.getTitle())) { cleared = true; break; }
    await sleep(500);
  }
  await sleep(1500);
  return cleared;
}
// Gives up on a hidden window's work after a while instead of leaving it open forever.
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_r, reject) => setTimeout(() => reject(new Error(`${what} took too long`)), ms))]);

// Reads chats (as Claude's own page does) and notes which of your artifacts each one mentions,
// so an artifact can be attached to the chat it was made in.
// (the pattern is kept out here as ordinary text: written inside the page script below, its backslashes would be lost)
const MADE_FILES = '/mnt/user-data/outputs/([^"\\\\\\n<>|]{1,140}?\\.(?:xlsx|xlsm|xls|docx|doc|pptx|ppt|pdf|csv|md|html|txt|png|jpe?g|svg|json|zip))(?![A-Za-z0-9])';
// Things made in a chat that have a Claude address of their own: Claude Docs, Slides, Designs and other artifacts.
// (In the chat's data the slashes may be written with a backslash in front.)
const MADE_LINKS = 'claude\\.ai\\\\?/(?:code\\\\?/)?artifact\\\\?/([0-9A-Za-z][0-9A-Za-z_-]{7,60})';
const NAME_NEAR = '"(?:name|title)"\\s*:\\s*"((?:[^"\\\\]|\\\\.){3,160})"';
const relationsScript = (chats, artifacts) => `(async () => {
  const chats = ${JSON.stringify(chats)};
  const arts = ${JSON.stringify(artifacts)};
  const out = { relations: [], byName: [], files: [], made: [], scanned: {}, notes: [], failedStatus: {} };
  const madeLink = new RegExp(${JSON.stringify(MADE_LINKS)}, 'gi'), nameNear = new RegExp(${JSON.stringify(NAME_NEAR)}, 'g');
  // Files Claude made in a chat (the ones under Outputs in the chat's side panel): spreadsheets, documents, PDFs.
  const made = new RegExp(${JSON.stringify(MADE_FILES)}, 'gi');
  const json = async u => { const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } }); return r.ok ? r : null; };
  let orgs = [];
  try { const r = await json('/api/organizations'); const x = r ? await r.json() : []; orgs = Array.isArray(x) ? x : (x.data || []); } catch (e) { out.notes.push('relations: ' + e.message); }
  for (const c of chats) {
    let text = null;
    for (const o of orgs) {
      for (const q of ['?tree=True&rendering_mode=messages&render_all_tools=true', '']) {
        try {
          const r = await fetch('/api/organizations/' + o.uuid + '/chat_conversations/' + c.uuid + q, { credentials: 'include', headers: { accept: 'application/json' } });
          if (r.ok) { text = await r.text(); break; }
          out.failedStatus[r.status] = (out.failedStatus[r.status] || 0) + 1;
        } catch (e) { out.failedStatus[String(e.message || e)] = 1; }
      }
      if (text) break;
    }
    if (text === null) continue;
    out.scanned[c.url] = c.updated || 'seen';
    for (const a of arts) {
      if (a.id.length >= 8 && text.includes(a.id)) out.relations.push([c.url, a.url]);
      else if (a.name && a.name.length >= 12 && (text.includes(a.name) || text.includes(JSON.stringify(a.name).slice(1, -1)))) out.byName.push([c.url, a.url]);
    }
    // What this chat made that has its own address (Claude Docs, Slides, Designs, artifacts): every artifact address in
    // the chat, with the nearest name or title beside it.
    { const flat = text.split('\\\\"').join('"'), seenIds = new Set(); let lm; madeLink.lastIndex = 0;
      while ((lm = madeLink.exec(flat)) && seenIds.size < 80) {
        const id = lm[1]; if (seenIds.has(id)) continue; seenIds.add(id);
        const from = Math.max(0, lm.index - 3000), win = flat.slice(from, lm.index + 500); let best = '', bestD = 1e9, nm; nameNear.lastIndex = 0;
        while ((nm = nameNear.exec(win))) { const d = Math.abs(from + nm.index - lm.index); let val = nm[1]; try { val = JSON.parse('"' + nm[1] + '"'); } catch (e) { /* as written */ } if (!/\\s/.test(val) && (/[_:\\/]/.test(val) || val === val.toLowerCase() || /^[A-Z][a-z0-9]+([A-Z][a-z0-9]+)+$/.test(val))) continue;      // a tool's or a setting's name, not a title
          if (d < bestD) { bestD = d; best = val; } }
        out.made.push([c.url, 'https://claude.ai/artifact/' + id, String(best || '').slice(0, 160)]);
      } }
    { const names = new Set(); let mm; made.lastIndex = 0; while ((mm = made.exec(text)) && names.size < 60) { const nm0 = mm[1].split('/').pop().trim(); if (nm0.length > 4 && !/[*?{}$]/.test(nm0) && /[A-Za-z0-9]/.test(nm0.replace(/\\.[A-Za-z0-9]+$/, ''))) names.add(nm0); } for (const nm of names) out.files.push([c.url, nm]); }
    if (!out.sample) out.sample = { outputsFolderMentions: text.split('user-data/outputs').length - 1, fileNameKeys: text.split('file_name').length - 1, status: 'ok', length: text.length, mentionsArtifact: /artifact/i.test(text), head: text.slice(0, 300) };
  }
  return out;
})()`;

async function fetchLibrary(opts = {}) {
  const result = { signedIn: true, chats: [], projects: [], artifacts: [], notes: [] };
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.setAudioMuted(true);
  const guard = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 600000);
  try {
    const cleared = await openHidden(win, 'https://claude.ai/recents');
    if (/\/(login|logout|signup)/.test(win.webContents.getURL())) { result.signedIn = false; return result; }
    if (!cleared) { result.notes.push('Claude\u2019s security check did not finish, so the lists were not read this time'); result.blocked = true; return result; }

    const api = await win.webContents.executeJavaScript(API_SCRIPT, true);
    result.chats = api.chats;
    result.chatsComplete = !!api.chatsComplete && api.chats.length > 0;   // the full list, straight from Claude
    result.projects = api.projects;
    result.notes.push(...api.notes);
    if ((api.status === 401 || api.status === 403) && !api.chats.length) result.signedIn = false;

    if (!result.chats.length) {
      result.chats = await win.webContents.executeJavaScript(scrollHarvest(LIB_PATTERNS.chats), true);
      result.notes.push(`read ${result.chats.length} chats from the Recents page`);
    }
    if (!win.isDestroyed()) {
      await openHidden(win, 'https://claude.ai/artifacts');
      result.artifacts = await win.webContents.executeJavaScript(scrollHarvest(LIB_PATTERNS.artifacts), true);
    }
    // Code, Design and Scheduled: find each page from Claude's own navigation, then read what it lists.
    for (const [kind, label, fallback] of [['code', '^code$', '/code'], ['design', '^design$', '/design'], ['scheduled', '^(scheduled|schedules?|routines?)$', '/code/routines'], ['skills', '^(skills|customi[sz]e)$', '/customize/skills']]) {
      if (win.isDestroyed()) break;
      const found = await win.webContents.executeJavaScript(discoverPage(label), true).catch(() => null);
      // Skills live under Customize (Customize \u203a Skills); Claude's sidebar may point at Customize itself.
      const usable = found && !(kind === 'scheduled' && /customi[sz]e|skills/i.test(found)) ? found : null;
      const prefix = kind === 'skills' && usable && !/skills$/.test(usable) ? usable + '/skills' : (usable || fallback);
      // Where Claude's own sidebar points (a "Scheduled" link that leads into Customize is not the routines page).
      if (found && !(kind === 'scheduled' && /customi[sz]e|skills/i.test(found))) (result.pagePaths || (result.pagePaths = {}))[kind] = found;
      await openHidden(win, 'https://claude.ai' + prefix);
      if (win.isDestroyed()) break;
      const pattern = kind === 'code'
        ? LIB_PATTERNS.code
        : '^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (kind === 'skills' ? '/(?!(new|create|edit|upload)$)[A-Za-z0-9_.:%-]{3,}' : '/(?!(new|create|edit)$)[A-Za-z0-9_-]{6,}');
      result[kind] = await win.webContents.executeJavaScript(scrollHarvest(pattern), true).catch(() => []);
      result.notes.push(`${kind}: read ${result[kind].length} from ${prefix}`);
    }
    // Which chat each artifact came from: check chats that are new or changed since last time (newest first).
    if (!win.isDestroyed() && result.signedIn) {
      const seen = opts.scanned || {};
      const toScan = (result.chats || [])
        .filter(c => c.url && seen[c.url] !== (c.updated || 'seen'))
        .slice(0, 150)
        .map(c => ({ url: c.url, uuid: c.url.split('/chat/')[1], updated: c.updated || null }));
      const known = new Map();
      for (const a of [...(opts.knownArtifacts || []), ...(result.artifacts || []), ...(result.design || [])]) {
        const x = typeof a === 'string' ? { url: a } : a;
        if (x && x.url && !known.has(x.url)) known.set(x.url, x.name || (known.get(x.url) || {}).name || '');
        else if (x && x.url && x.name) known.set(x.url, x.name);
      }
      const arts = [...known].map(([u, name]) => ({ url: u, name, id: u.replace(/\/+$/, '').split('/').pop() }));
      result.relations = [];
      result.diag = { chatsToCheck: toScan.length, chatsWaiting: (result.chats || []).filter(c => c.url && seen[c.url] !== (c.updated || 'seen')).length, artifactsKnown: arts.length };
      if (toScan.length) {
        await openHidden(win, 'https://claude.ai/recents');
        const rel = await win.webContents.executeJavaScript(relationsScript(toScan, arts), true).catch(e => ({ relations: [], byName: [], files: [], scanned: {}, notes: [String(e)] }));
        result.chatFiles = rel.files || [];
        result.chatMade = rel.made || [];
        // A name counts only when exactly one chat mentions it (common names are ignored).
        const chatsPerArt = new Map();
        for (const [c, a] of rel.byName || []) chatsPerArt.set(a, (chatsPerArt.get(a) || new Set()).add(c));
        const byName = [...chatsPerArt].filter(([, cs]) => cs.size === 1).map(([a, cs]) => [[...cs][0], a]);
        result.relations = rel.relations.concat(byName);
        result.scanned = rel.scanned;
        Object.assign(result.diag, { chatsChecked: Object.keys(rel.scanned).length, byId: rel.relations.length, byName: byName.length, nameAmbiguous: chatsPerArt.size - byName.length, failedStatus: rel.failedStatus, sample: rel.sample || null });
        result.notes.push(`links: checked ${Object.keys(rel.scanned).length} chats, found ${result.relations.length}, ${(rel.made || []).length} documents and artifacts made in chats, and ${(rel.files || []).length} files`, ...(rel.notes || []));
      }
      // Documents that still have no name (the chat did not give one): open each one's page and read the name it shows.
      const noName = [...new Set((opts.unnamed || []).concat((result.chatMade || []).filter(x => !x[2]).map(x => x[1])))].filter(u => /^https:\/\/claude\.ai\/(code\/)?artifact\//.test(u)).slice(0, 15);
      result.titles = [];
      for (const u of noName) {
        if (win.isDestroyed()) break;
        await openHidden(win, u);
        const got = await win.webContents.executeJavaScript(`(async () => {
          const read = () => { const h = document.querySelector('h1, [role="heading"][aria-level="1"]'), og = document.querySelector('meta[property="og:title"]'); return [document.title, h ? h.innerText : '', og ? og.content : ''].map(x => String(x || '').trim().slice(0, 200)); };
          let r = read();
          for (let i = 0; i < 10 && !/[A-Za-z]/.test(r[0].replace(/claude|artifact|loading|untitled/gi, '')) && !r[1]; i++) { await new Promise(z => setTimeout(z, 500)); r = read(); }
          return r;
        })()`, true).catch(() => null);
        if (got) result.titles.push([u, got]);
      }
      if (noName.length) result.notes.push(`names: opened ${noName.length} documents to read their names`);
      // Artifacts still without a chat: open their page and look for a link back to the chat it was made in.
      const linked = new Set(result.relations.map(([, a]) => a).concat(opts.linkedArtifacts || []));
      const pagesToCheck = arts.filter(a => !linked.has(a.url) && !(opts.pageChecked || {})[a.url]).slice(0, 25);
      result.pageChecked = {};
      let byPage = 0;
      for (const a of pagesToCheck) {
        if (win.isDestroyed()) break;
        await openHidden(win, a.url);
        const chats = await win.webContents.executeJavaScript(`(() => {
          const out = new Set();
          for (const el of document.querySelectorAll('a[href*="/chat/"]')) {
            if (el.closest('nav, aside, [role="navigation"], [data-testid*="sidebar" i]')) continue;   // not Claude's sidebar
            try { const u = new URL(el.getAttribute('href'), location.href); if (/^\\/chat\\/[0-9a-fA-F-]{8,}/.test(u.pathname)) out.add(u.origin + u.pathname); } catch (e) {}
          }
          return [...out];
        })()`, true).catch(() => []);
        result.pageChecked[a.url] = chats.length;
        if (chats.length === 1) { result.relations.push([chats[0], a.url]); byPage++; }
      }
      if (result.diag) Object.assign(result.diag, { artifactPagesChecked: pagesToCheck.length, byArtifactPage: byPage });
    }
  } catch (e) {
    result.notes.push(String(e && e.message || e));
  } finally {
    clearTimeout(guard);
    if (!win.isDestroyed()) win.destroy();
  }
  return result;
}

// Deletes chats from your Claude account, using the same request Claude's own website sends
// when you delete a chat there. Only chat addresses are accepted.
const deleteScript = (items) => `(async () => {
  const items = ${JSON.stringify(items)};
  const out = { deleted: [], failed: [] };
  let orgs = null;
  const allOrgs = async () => {
    if (orgs) return orgs;
    try { const r = await fetch('/api/organizations', { credentials: 'include' }); const x = await r.json(); orgs = (Array.isArray(x) ? x : (x.data || [])).map(o => o.uuid); } catch (e) { orgs = []; }
    return orgs;
  };
  for (const it of items) {
    const m = /\\/chat\\/([0-9a-fA-F-]{8,})/.exec(it.url);
    if (!m) { out.failed.push({ url: it.url, status: 'not a chat' }); continue; }
    let status = 'no account';
    for (const o of it.org ? [it.org] : await allOrgs()) {
      try {
        const r = await fetch('/api/organizations/' + o + '/chat_conversations/' + m[1], { method: 'DELETE', credentials: 'include' });
        status = r.status;
        if (r.ok || r.status === 204) break;
      } catch (e) { status = String(e.message || e); }
    }
    if (status === 204 || (typeof status === 'number' && status >= 200 && status < 300)) out.deleted.push(it.url); else out.failed.push({ url: it.url, status });
  }
  return out;
})()`;

ipcMain.handle('claude-delete-chats', async (_e, items) => {
  items = (Array.isArray(items) ? items : []).filter(x => x && typeof x.url === 'string' && /^https:\/\/claude\.ai\/chat\/[0-9a-fA-F-]{8,}/.test(x.url));
  if (!items.length) return { deleted: [], failed: [] };
  const win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try {
    const cleared = await openHidden(win, 'https://claude.ai/recents');
    if (/\/(login|logout|signup)/.test(win.webContents.getURL())) return { deleted: [], failed: items.map(i => ({ url: i.url, status: 'not signed in' })) };
    if (!cleared) return { deleted: [], failed: items.map(i => ({ url: i.url, status: 'Claude\u2019s security check did not finish; try again' })) };
    return await withTimeout(win.webContents.executeJavaScript(deleteScript(items), true), 30000 + items.length * 5000, 'Deleting');
  } catch (e) {
    return { deleted: [], failed: items.map(i => ({ url: i.url, status: String(e && e.message || e) })) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});

// Renames a chat in Claude (the same as Rename in Claude's own menu).
const renameScript = (url, name, org) => `(async () => {
  const m = /\\/chat\\/([0-9a-fA-F-]{8,})/.exec(${JSON.stringify(url)});
  if (!m) return { ok: false, status: 'not a chat' };
  let orgs = ${JSON.stringify(org ? [org] : null)};
  if (!orgs) {
    try { const r = await fetch('/api/organizations', { credentials: 'include' }); const x = await r.json(); orgs = (Array.isArray(x) ? x : (x.data || [])).map(o => o.uuid); } catch (e) { orgs = []; }
  }
  let status = 'no account';
  for (const o of orgs) {
    for (const method of ['PUT', 'PATCH']) {
      try {
        const r = await fetch('/api/organizations/' + o + '/chat_conversations/' + m[1], {
          method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ${JSON.stringify(name)} }),
        });
        status = r.status;
        if (r.ok) return { ok: true, status };
        if (r.status !== 405 && r.status !== 400) break;
      } catch (e) { status = String(e.message || e); }
    }
  }
  return { ok: false, status };
})()`;

ipcMain.handle('claude-rename-chat', async (_e, item) => {
  const url = item && typeof item.url === 'string' ? item.url : '';
  const name = item && typeof item.name === 'string' ? item.name.trim().slice(0, 300) : '';
  if (!/^https:\/\/claude\.ai\/chat\/[0-9a-fA-F-]{8,}/.test(url) || !name) return { ok: false, status: 'not a chat' };
  const win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try {
    const cleared = await openHidden(win, 'https://claude.ai/recents');
    if (/\/(login|logout|signup)/.test(win.webContents.getURL())) return { ok: false, status: 'not signed in' };
    if (!cleared) return { ok: false, status: 'Claude\u2019s security check did not finish; try again' };
    return await withTimeout(win.webContents.executeJavaScript(renameScript(url, name, item.org || null), true), 30000, 'Renaming');
  } catch (e) {
    return { ok: false, status: String(e && e.message || e) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});

// Reads the colours and fonts of a profile's Claude design system (for Chief of Staff's look).
ipcMain.handle('design-look', async (_e, url) => {
  if (typeof url !== 'string' || !/^https:\/\/claude\.ai\//.test(url)) return { ok: false, status: 'not a Claude page' };
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try {
    const cleared = await openHidden(win, url);
    if (/\/(login|logout|signup)/.test(win.webContents.getURL())) return { ok: false, status: 'not signed in' };
    if (!cleared) return { ok: false, status: 'Claude\u2019s security check did not finish; try again' };
    await sleep(3500); // the design system draws itself after the page loads
    const look = await withTimeout(require('./look').readLook(win.webContents, win.webContents.session, path.join(app.getPath('userData'), 'Design fonts')), 60000, 'Reading the design system');
    if (!look.colours.length && !look.headFont) return { ok: false, status: 'no colours or fonts found on that page' };
    return { ok: true, look };
  } catch (e) {
    return { ok: false, status: String(e && e.message || e) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});

// ---------- Chief of Staff: org chart export ----------
let lastExport = null;
ipcMain.handle('cos-export', async (_e, req) => {
  const ext = req && req.format === 'png' ? 'png' : 'pdf';
  const html = req && typeof req.html === 'string' ? req.html : '';
  if (!html || html.length > 20e6) return { ok: false, status: 'nothing to export' };
  const base = String(req.name || 'Org chart').replace(/[\/\\:*?"<>|]/g, '-').slice(0, 100);
  const r = await dialog.showSaveDialog(mainWindow, { title: 'Export Org Chart', defaultPath: path.join(app.getPath('documents'), `${base}.${ext}`), filters: [{ name: ext === 'png' ? 'PNG image' : 'PDF', extensions: [ext] }] });
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  const tmp = path.join(app.getPath('userData'), 'org-chart-export.html');
  fs.writeFileSync(tmp, html);
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  try {
    win.setContentSize(320, 240);            // start small, so the page is only as big as the chart
    await win.loadFile(tmp);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => 0)', true);
    await sleep(300);
    const { w, h } = await win.webContents.executeJavaScript('({ w: Math.ceil(document.documentElement.scrollWidth), h: Math.ceil(document.documentElement.scrollHeight) })', true);
    win.setContentSize(w, h);
    await sleep(150);
    if (ext === 'pdf') {
      const buf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: false, margins: { marginType: 'none' }, pageSize: { width: Math.min(200, Math.max(w + 8, 400) / 96), height: Math.min(200, Math.max(h + 8, 300) / 96) } });
      fs.writeFileSync(r.filePath, buf);
    } else {
      const scale = Math.max(1, Math.min(2, 12000 / Math.max(w, h)));
      win.webContents.setZoomFactor(scale);
      win.setContentSize(Math.ceil((w + 4) * scale), Math.ceil((h + 4) * scale));
      await sleep(400);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(r.filePath, img.toPNG());
    }
    lastExport = r.filePath;
    return { ok: true, file: r.filePath };
  } catch (e) {
    return { ok: false, status: String(e && e.message || e) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
});
ipcMain.handle('cos-show-export', () => { if (lastExport) shell.showItemInFolder(lastExport); });

// Reads what a Claude page says (for example a scheduled task: its name, schedule and instructions),
// so details are taken from Claude rather than typed into the app. Claude pages only.
const PAGE_DETAILS = `(() => {
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const fields = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"], input:not([type])')].filter(vis)
    .map(e => (e.value !== undefined && e.tagName !== 'DIV' ? e.value : e.innerText) || '').map(s => s.trim()).filter(s => s.length > 0);
  const selects = [...document.querySelectorAll('select')].filter(vis).map(e => (e.options[e.selectedIndex] || {}).text || '').filter(Boolean);
  const heading = ((document.querySelector('main h1, [role="main"] h1, h1') || {}).innerText || '').trim();
  const mainEl = document.querySelector('main, [role="main"]') || document.body;
  const copy = mainEl.cloneNode(true);
  copy.querySelectorAll('nav, aside, [data-testid*="sidebar" i], [aria-label*="sidebar" i]').forEach(x => x.remove());
  const mainText = (copy.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  return { title: document.title, heading, mainText, text: (document.body.innerText || '').slice(0, 20000), fields: fields.slice(0, 40), selects: selects.slice(0, 20) };
})()`;
ipcMain.handle('claude-page-details', async (_e, url) => {
  if (typeof url !== 'string' || !isClaudeHost(url)) return { ok: false, status: 'not a Claude page' };
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try {
    const cleared = await openHidden(win, url);
    if (/\/(login|logout|signup)/.test(win.webContents.getURL())) return { ok: false, status: 'not signed in' };
    if (!cleared) return { ok: false, status: 'Claude’s security check did not finish; try again' };
    await sleep(2500);
    const d = await withTimeout(win.webContents.executeJavaScript(PAGE_DETAILS, true), 20000, 'Reading the page');
    // Deleted in Claude: the page itself says so (its heading, or the start of its own content, never Claude's
    // sidebar), or Claude sends you back to the list of tasks this one belonged to. Anything else (sign-in,
    // upgrade pages, a slow page) is not treated as deleted, and the app asks before removing anything.
    const asked = new URL(url).pathname.replace(/\/+$/, '');
    let now = '';
    try { now = new URL(win.webContents.getURL()).pathname.replace(/\/+$/, ''); } catch (e) { /* ignore */ }
    const listPath = asked.replace(/\/[^\/]+$/, '');
    const notFound = /^(page )?not found\b|^404\b/i.test(d.heading || '')
      || /^(?:\S+\s){0,6}?(page not found|this (task|routine|page|scheduled task) (doesn.t|does not|no longer) exist|has been deleted)/i.test(d.mainText || '');
    return Object.assign({ ok: true, gone: notFound || (!!now && now === listPath && listPath.length > 1) }, d);
  } catch (e) {
    return { ok: false, status: String(e && e.message || e) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});

// A Claude Project's scheduled tasks, from its own page: the Scheduled section ("Name · Every Monday at 6:09 AM")
// and the entries marked Scheduled in its Recents (with their links).
const PROJECT_SCHEDULED = `(() => {
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
  const items = [], seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    // Never Claude's own menus (its sidebar has a Scheduled item next to Design, Customize and so on).
    if (a.closest('nav, [role="navigation"], [role="menu"]')) continue;
    const row = a.closest('li, [role="listitem"], [role="row"]') || a.parentElement || a;
    if (row.querySelectorAll('a[href]').length > 1) continue;
    const txt = clean(row.innerText || a.innerText);
    // The Scheduled badge must be beside the link, not in its name (a chat called "Scheduled task setup" is a chat).
    const besides = clean(txt.replace(clean(a.innerText), ' '));
    if (!/\\bScheduled\\b/.test(besides) || /^scheduled$/i.test(clean(a.innerText)) || txt.length > 300) continue;
    let u; try { u = new URL(a.href); } catch (e) { continue; }
    // Only a chat or a scheduled task: never a page like Design, Customize, Projects or the project itself.
    if (u.origin !== location.origin || !/^\\/(code\\/)?(chat|task|tasks|routine|routines|scheduled|schedules?)\\/[^/]+/.test(u.pathname)) continue;
    const name = clean((a.innerText || '').split('\\n').map(x => x.trim().replace(/^[^\\p{L}\\p{N}]+/u, '')).filter(x => x && !/^scheduled$/i.test(x) && !/\\bago$|^just now$/i.test(x))[0] || '');
    if (!name || seen.has(u.pathname)) continue;
    seen.add(u.pathname);
    items.push({ name, url: u.origin + u.pathname });
  }
  const section = [];
  for (const el of document.querySelectorAll('div, section, li')) {
    if (el.children.length > 10) continue;
    const t = clean(el.innerText);
    if (t.length > 400 || !/^Scheduled\\b/.test(t)) continue;
    const body = t.replace(/^Scheduled\\s*/, '').replace(/\\s*Add$/, '');
    // Each task's own page (Scheduled tasks / Name), when the entry is a link.
    const pages = [];
    for (const a of el.querySelectorAll('a[href]')) {
      let u; try { u = new URL(a.href); } catch (e) { continue; }
      if (u.origin === location.origin && u.pathname !== location.pathname && !/^\\/(project|chat|new|projects|recents|design|customize)(\\/|$)/.test(u.pathname)) pages.push({ text: clean(a.innerText), url: u.origin + u.pathname });
    }
    // Each entry on its own: the innermost element reading "Name · When" (else split the text into lines).
    const leaves = [...el.querySelectorAll('*')].filter(e => /^.+?\\s+·\\s+.+$/.test(clean(e.innerText)) && ![...e.children].some(c => /·/.test(c.innerText || ''))).map(e => clean(e.innerText));
    for (const part of leaves.length ? leaves : body.split(/\\s{2,}|\\n/)) {
      const m = /^(.+?)\\s+·\\s+(.+)$/.exec(part.trim()); if (!m) continue;
      const pg = pages.find(x => x.text.startsWith(m[1].trim()));
      section.push({ name: m[1].trim(), when: m[2].trim(), page: pg ? pg.url : '' });
    }
  }
  const heading = clean((document.querySelector('h1') || {}).innerText || '');
  // The Scheduled section with nothing in it ("Scheduled  Add"): so the app knows the list is really empty.
  const sectionEmpty = [...document.querySelectorAll('div, section, li')].some(el => el.children.length < 6 && /^Scheduled\\s*Add$/.test(clean(el.innerText)));
  return { items, section: section.filter((x, i, a) => a.findIndex(y => y.name === x.name) === i), heading, sectionEmpty };
})()`;
ipcMain.handle('project-scheduled', async (_e, url) => {
  if (typeof url !== 'string' || !isClaudeHost(url) || !/\/project\//.test(url)) return { ok: false, status: 'not a Claude project' };
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try {
    const cleared = await openHidden(win, url);
    if (/\/(login|logout|signup)/.test(win.webContents.getURL())) return { ok: false, status: 'not signed in' };
    if (!cleared) return { ok: false, status: 'Claude’s security check did not finish' };
    await sleep(2500);
    const d = await withTimeout(win.webContents.executeJavaScript(PROJECT_SCHEDULED, true), 20000, 'Reading the project');
    return Object.assign({ ok: !!(d && d.heading) }, d);
  } catch (e) {
    return { ok: false, status: String(e && e.message || e) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});

let libraryRun = null;
// Opens a file Claude made in a chat (one of the chat's Outputs): fetched from Claude with your sign-in, saved to a
// temporary folder, and opened in its own app (Excel, Preview, Word). Nothing is kept or changed in Claude.
const chatFileScript = (conv, name) => `(async () => {
  const conv = ${JSON.stringify(conv)}, name = ${JSON.stringify(name)}, tried = [];
  let orgs = [];
  try { const r = await fetch('/api/organizations', { credentials: 'include', headers: { accept: 'application/json' } }); const x = r.ok ? await r.json() : []; orgs = Array.isArray(x) ? x : (x.data || []); } catch (e) { tried.push('orgs: ' + e.message); }
  const path = encodeURIComponent('/mnt/user-data/outputs/' + name);
  for (const o of orgs) {
    for (const u of ['/api/organizations/' + o.uuid + '/conversations/' + conv + '/wiggle/download-file?path=' + path,
                     '/api/organizations/' + o.uuid + '/chat_conversations/' + conv + '/wiggle/download-file?path=' + path,
                     '/api/organizations/' + o.uuid + '/conversations/' + conv + '/files/download?path=' + path]) {
      try {
        const r = await fetch(u, { credentials: 'include' });
        tried.push(r.status);
        if (!r.ok) continue;
        const type = r.headers.get('content-type') || '';
        const buf = new Uint8Array(await r.arrayBuffer());
        if (!buf.length || buf.length > 80e6 || (/json|html/.test(type) && !/\\.(json|html)$/i.test(name))) continue;
        let bin = ''; for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
        return { ok: true, b64: btoa(bin), type };
      } catch (e) { tried.push(String(e.message || e)); }
    }
  }
  return { ok: false, tried };
})()`;
ipcMain.handle('chat-file-open', async (e, chatUrl, name) => {
  if (!fromOwnWindow(e)) return { ok: false };
  const m = /^https:\/\/claude\.ai\/chat\/([0-9a-f-]{20,})/i.exec(String(chatUrl || ''));
  name = String(name || '');
  if (!m || !name || name.length > 160 || /[\\/\0]|^\./.test(name) || !/\.[A-Za-z0-9]{2,5}$/.test(name)) return { ok: false, why: 'not a file from a chat' };
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const guard = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 90000);
  try {
    await openHidden(win, 'https://claude.ai/recents');
    if (/\/(login|logout|signup)/.test(win.webContents.getURL())) return { ok: false, why: 'signed out' };
    const got = await withTimeout(win.webContents.executeJavaScript(chatFileScript(m[1], name), true), 70000, 'Fetching the file');
    if (!got || !got.ok) return { ok: false, why: 'not found', tried: (got && got.tried) || [] };
    const dir = path.join(app.getPath('temp'), 'Claude Navigator files', m[1].slice(0, 8));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(got.b64, 'base64'));
    const problem = process.env.NAV_TEST_MS ? '' : await shell.openPath(file);
    return problem ? { ok: false, why: problem, file } : { ok: true, file };
  } catch (err) { return { ok: false, why: String(err && err.message || err) }; }
  finally { clearTimeout(guard); if (!win.isDestroyed()) win.destroy(); }
});
ipcMain.handle('library-refresh', (_e, opts) => libraryRun || (libraryRun = fetchLibrary(opts || {}).finally(() => { libraryRun = null; })));

// Quick look at the links Claude is showing in the visible pane (its sidebar of recent chats).
ipcMain.handle('harvest-pane', async (_e, id, kind) => {
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed() || !isClaudeHost(wc.getURL()) || !LIB_PATTERNS[kind]) return [];
  return wc.executeJavaScript(`(${COLLECT_FN})(${JSON.stringify(LIB_PATTERNS[kind])})`, true).catch(() => []);
});

// ---------- Folders on this computer ----------
// Settings live next to the app's other data: { enabled, root }.
const syncSettingsFile = () => path.join(app.getPath('userData'), 'folder-sync.json');
function readSyncSettings() {
  try { return JSON.parse(fs.readFileSync(syncSettingsFile(), 'utf8')); } catch (e) { return { enabled: false, asked: false }; }
}
function writeSyncSettings(s) { fs.writeFileSync(syncSettingsFile(), JSON.stringify(s, null, 2)); }
const defaultRoot = () => {
  let docs = app.getPath('documents');
  if (path.resolve(docs) === path.resolve(app.getPath('home'))) docs = path.join(docs, 'Documents');   // systems with no Documents folder
  return path.join(docs, 'Claude Navigator');
};
let folderSync = null;
// For the startup log: what kind of place the folder is in (never its name), and how long the disk takes to answer
// one question there, measured against the same question about the app's own data folder on this Mac's own disk.
async function diskProbe(root) {
  try {
    const home = app.getPath('home'), r = path.resolve(root);
    let where = 'this Mac';
    if (r.includes(path.join('Library', 'Mobile Documents'))) where = 'iCloud Drive';
    else if (r.includes(path.join('Library', 'CloudStorage'))) where = 'a cloud storage folder (OneDrive, Dropbox, Google Drive or similar)';
    else if (/onedrive|dropbox|google ?drive/i.test(r)) where = 'a cloud storage folder (by its name)';
    else {
      const inDocs = r.startsWith(path.join(home, 'Documents') + path.sep), inDesk = r.startsWith(path.join(home, 'Desktop') + path.sep);
      let icloudDocs = false; try { await fs.promises.lstat(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', inDesk ? 'Desktop' : 'Documents')); icloudDocs = true; } catch (e) { /* not kept in iCloud */ }
      where = inDocs || inDesk ? `your ${inDesk ? 'Desktop' : 'Documents'} folder${icloudDocs ? ', which iCloud keeps (Desktop & Documents is on)' : ', not kept in iCloud'}` : 'another folder on this Mac';
    }
    const time = async p => { const t = process.hrtime.bigint(); for (let i = 0; i < 20; i++) { try { await fs.promises.lstat(p); } catch (e) { /* still timed */ } } return Number(process.hrtime.bigint() - t) / 20e6; };
    const there = await time(r), here = await time(app.getPath('userData'));
    mark(`synced folder is in ${where}; one question to the disk takes ${there.toFixed(1)} ms there, ${here.toFixed(1)} ms on this Mac's own disk`);
  } catch (e) { /* log only */ }
}
function startSync(root) {
  if (folderSync) folderSync.unwatch();
  folderSync = new FolderSync(root);
  folderSync.cacheFile = path.join(app.getPath('userData'), 'link-cache.json');
  diskProbe(root);
  try { folderSync.ensureRoot(); folderSync.watch(() => send('fs-changed')); } catch (e) { /* reported when the app next reads the folder */ }
}
ipcMain.handle('fs-status', () => {
  const s = readSyncSettings();
  return { enabled: !!s.enabled, asked: !!s.asked, root: s.root || defaultRoot(), defaultRoot: defaultRoot(), platform: process.platform };
});
// Folders that must never be used as the synced folder: everything in them would become part of the app.
function rootProblem(r) {
  const home = app.getPath('home');
  const bad = [path.parse(r).root, home, app.getPath('documents'), app.getPath('desktop'), app.getPath('downloads'), path.join(home, 'Library')];
  if (bad.some(b => path.resolve(b) === path.resolve(r))) return 'Choose (or make) a folder of its own for your folders, not your whole home, Documents, Desktop or Downloads folder.';
  if (path.resolve(r).startsWith(path.join(home, 'Library') + path.sep)) return 'That folder is inside the hidden Library folder. Choose another one.';
  return null;
}
const isEmptyDir = d => { try { return fs.readdirSync(d).filter(n => !n.startsWith('.')).length === 0; } catch (e) { return !fs.existsSync(d); } };
ipcMain.handle('fs-enable', async (_e, root) => {
  const s = readSyncSettings();
  const oldRoot = s.root || defaultRoot();
  const r = path.resolve(typeof root === 'string' && root ? root : oldRoot);
  const problem = rootProblem(r);
  if (problem) return { error: problem };
  let moved = false;
  // Changing the location moves your folders (and the files in them) to the new place.
  if (r !== path.resolve(oldRoot) && s.enabled && fs.existsSync(oldRoot)) {
    if (r.startsWith(path.resolve(oldRoot) + path.sep) || path.resolve(oldRoot).startsWith(r + path.sep)) return { error: 'The new place cannot be inside the current folder (or the other way round).' };
    if (!isEmptyDir(r)) return { error: 'That folder already has things in it. Choose an empty folder, or make a new one, and your folders will be moved there.' };
    if (folderSync) folderSync.unwatch();
    try {
      if (fs.existsSync(r)) fs.rmdirSync(r);
      try { fs.renameSync(oldRoot, r); }
      catch (err) {                                   // another drive: copy, then put the old copy in the Trash
        fs.cpSync(oldRoot, r, { recursive: true });
        await shell.trashItem(oldRoot).catch(() => {});
      }
      moved = true;
    } catch (err) {
      if (s.enabled) startSync(oldRoot);
      return { error: `Could not move your folders: ${err.message}` };
    }
  }
  writeSyncSettings({ enabled: true, asked: true, root: r });
  startSync(r);
  return { enabled: true, root: r, moved };
});
ipcMain.handle('fs-disable', (_e, askedOnly) => {
  const s = readSyncSettings();
  writeSyncSettings(Object.assign(s, { enabled: false, asked: true }));
  if (folderSync) folderSync.unwatch();
  folderSync = null;
  return { enabled: false };
});
ipcMain.handle('fs-choose-root', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title: 'Choose where your folders live', properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('documents') });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});
// Reading the folder never holds the app up, and two requests at once share one reading.
let scanning = null;
ipcMain.handle('fs-scan', () => {
  if (!folderSync) return null;
  if (scanning && scanning.of === folderSync) return scanning.p;
  const fsync = folderSync;
  const p = (async () => {
    try {
      counts.reads++;
      const out = await fsync.scanAsync();
      const st = fsync.lastScan || {};
      if (st.ms > 1500) mark(`folder read: ${st.entries} items in ${st.folders} folders, ${st.linksRead} link files opened`, st.ms);
      if (fsync === folderSync && !fsync.watcher && !fsync.poll) fsync.watch(() => send('fs-changed'));   // folder is back: watch it again
      return out;
    } catch (e) { return { error: e.code === 'EPERM' || e.code === 'EACCES' ? 'no-access' : (e.code || e.message) }; }
    finally { if (scanning && scanning.p === p) scanning = null; }
  })();
  scanning = { of: fsync, p };
  return p;
});
ipcMain.handle('fs-apply', async (_e, payload) => {
  if (!folderSync) return null;
  const fsync = folderSync;
  counts.writes++;
  try { const r = await fsync.apply(payload || {}); const st = fsync.lastApply || {}; if (st.ms > 1500) mark(`folder written: ${st.nodes} items checked, ${st.changed} changed`, st.ms); return r; } catch (e) { return { map: {}, errors: [e.message] }; }
});
ipcMain.handle('fs-open', (_e, rel) => { if (folderSync) return shell.openPath(folderSync.abs(rel)); });
// The Chief of Staff's reference files, kept by the app in a hidden folder in each company folder (the folder
// sync skips hidden folders): a live overview of the team, and what the Chief of Staff has learned.
const COS_NOTE_NAMES = ['Team overview.md', 'What the Chief of Staff has learned.md'];
ipcMain.handle('fs-cos-notes', async (_e, profileRel, files) => {
  if (!folderSync || typeof profileRel !== 'string' || !profileRel || /(^|[\\/])\.\.([\\/]|$)/.test(profileRel) || !files || typeof files !== 'object') return false;
  try {
    const dir = folderSync.abs(path.join(profileRel, '.chief-of-staff'));
    await fs.promises.mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      if (!COS_NOTE_NAMES.includes(name) || typeof text !== 'string' || text.length > 2e6) continue;
      const f = path.join(dir, name);
      let old = null; try { old = await fs.promises.readFile(f, 'utf8'); } catch (e) { /* new */ }
      if (old !== text) await fs.promises.writeFile(f, text);
    }
    return dir;
  } catch (e) { return false; }
});
ipcMain.handle('fs-reveal', (_e, rel) => { if (folderSync) shell.showItemInFolder(rel ? folderSync.abs(rel) : folderSync.root); });
ipcMain.handle('fs-abs', (_e, rel) => (folderSync ? folderSync.abs(rel || '') : null));
ipcMain.handle('fs-copy', (_e, srcRel, destDirRel, keepName) => {
  if (!folderSync) return { error: 'Folders on this Mac are not turned on' };
  return folderSync.copy(srcRel, destDirRel, !!keepName).catch(e => ({ error: e.message }));
});
ipcMain.handle('fs-import', (_e, paths, destRel) => (folderSync ? folderSync.importFiles(paths, destRel) : []));
// New Word / Excel / PowerPoint / text file from a blank template, then open it in its own app.
const NEW_FILE_TYPES = { word: 'docx', excel: 'xlsx', powerpoint: 'pptx', text: 'txt' };
ipcMain.handle('fs-new-file', async (_e, kind, destRel, name) => {
  if (!folderSync || !NEW_FILE_TYPES[kind]) return { error: 'Folders on this Mac are not turned on' };
  const ext = NEW_FILE_TYPES[kind];
  const dir = folderSync.abs(destRel || '');
  fs.mkdirSync(dir, { recursive: true });
  const stem = String(name || 'Untitled').replace(/[\/\\:*?"<>|]/g, '-').replace(new RegExp(`\\.${ext}$`, 'i'), '').trim() || 'Untitled';
  let target = path.join(dir, `${stem}.${ext}`);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem} ${i}.${ext}`);
  fs.writeFileSync(target, fs.readFileSync(path.join(__dirname, 'templates', `blank.${ext}`)));
  const err = await shell.openPath(target);
  return { rel: folderSync.rel(target), error: err || null };
});

// ---------- Live preview ----------
// Started by "Live Preview.command": the app runs from this folder, fetches new changes from GitHub every
// 20 seconds, and refreshes itself as soon as any of its files change (the window reloads; changes to the
// app's core restart it). Your folders and Claude sign-in are the same as in the installed app.
const LIVE = process.env.CLAUDE_NAV_LIVE === '1' && !app.isPackaged;
function setUpLivePreview() {
  if (!LIVE) return;
  const { execFile } = require('child_process');
  const repo = path.join(__dirname, '..');
  let lastPull = 'starting';
  const pull = () => execFile('git', ['-C', repo, 'pull', '--ff-only', '--quiet'], { env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }), timeout: 60000 },
    (err) => {
      const now = err ? 'manual' : 'auto';
      if (now !== lastPull) send('live-status', { autoPull: now === 'auto' });
      lastPull = now;
    });
  pull();
  setInterval(pull, 20000);
  let timer = null, restart = false;
  const files = ['index.html', 'preload.js', 'main.js', 'fsync.js', 'monday.js', 'look.js', 'package.json'];
  fs.watch(__dirname, (_ev, name) => {
    if (!name || !files.includes(String(name))) return;
    if (!['index.html'].includes(String(name))) restart = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (restart) { app.relaunch(); app.exit(0); return; }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
    }, 700);
  });
}
ipcMain.handle('live-info', () => ({ live: LIVE }));

// ---------- Updates ----------
// Signed releases check for a newer version on start-up and every few hours, download it in the background,
// and install it when you restart (or quit). Builds made on this Mac by the install script do not update
// themselves (they are updated by running the script again).
const pkg = require('./package.json');
let updater = null;
const update = { state: 'idle', version: null, error: null };
function setUpUpdates() {
  if (!app.isPackaged || pkg.localBuild || LIVE) { update.state = 'unavailable'; return; }
  try { updater = require('electron-updater').autoUpdater; } catch (e) { update.state = 'unavailable'; return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => { update.state = 'checking'; });
  updater.on('update-not-available', () => { update.state = 'current'; });
  updater.on('update-available', info => { update.state = 'downloading'; update.version = info && info.version; });
  updater.on('update-downloaded', info => { update.state = 'ready'; update.version = info && info.version; send('update-ready', { version: update.version }); });
  updater.on('error', err => { update.state = 'error'; update.error = String((err && err.message) || err).split('\n')[0]; });
  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 15000);
  setInterval(check, 4 * 60 * 60e3);
}
ipcMain.handle('update-status', () => Object.assign({ current: app.getVersion() }, update));
ipcMain.handle('update-check', async () => {
  if (!updater) return Object.assign({ current: app.getVersion() }, update);
  try { await updater.checkForUpdates(); } catch (e) { update.state = 'error'; update.error = String(e.message || e); }
  return Object.assign({ current: app.getVersion() }, update);
});
ipcMain.handle('update-install', async () => {
  if (!updater || update.state !== 'ready') return;
  try { await session.fromPartition(PARTITION).cookies.flushStore(); } catch (e) { /* quit anyway */ }
  setImmediate(() => updater.quitAndInstall());
});

// Stay signed in across restarts and updates. Many sites (iCloud among them) sign you in with "session" cookies,
// which are thrown away whenever the app quits, and every update quits the app. They are kept for 30 days
// instead (as a browser set to reopen its tabs does), and everything is written to disk before quitting.
function keepSignIns() {
  const ses = session.fromPartition(PARTITION);
  const keep = c => {
    if (!c.session || !c.domain) return;
    const host = c.domain.replace(/^\./, '');
    ses.cookies.set({
      url: `http${c.secure ? 's' : ''}://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
      sameSite: c.sameSite, expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400, ...(c.hostOnly ? {} : { domain: c.domain }),
    }).catch(() => {});
  };
  ses.cookies.on('changed', (_e, cookie, _cause, removed) => { if (!removed) keep(cookie); });
  ses.cookies.get({}).then(all => all.forEach(keep)).catch(() => {});
  let flushed = false;
  app.on('before-quit', () => { try { mailindex.stop(); } catch (err) { /* not started */ } });
  app.on('before-quit', e => {
    if (flushed) return;
    e.preventDefault();
    ses.cookies.flushStore().catch(() => {}).finally(() => { flushed = true; app.quit(); });
  });
}

// Stay signed in to Clara. Clara keeps its sign-in inside the tab itself ("session storage"), which a browser throws
// away when the tab closes, so every restart (and the hidden page that reads her list) started signed out. The app
// keeps a copy, encrypted with the Mac's Keychain, and puts it back whenever a Clara page opens without one.
const tabKeepFile = () => path.join(app.getPath('userData'), 'tab-signins.bin');
const tabKeepReaders = new Set();
let tabKeep = null;
const tabKeepLoad = () => {
  if (tabKeep) return tabKeep;
  try { tabKeep = JSON.parse(safeStorage.decryptString(fs.readFileSync(tabKeepFile()))) || {}; } catch (e) { tabKeep = {}; }
  return tabKeep;
};
const tabKeepSave = () => {
  try {
    if (!Object.keys(tabKeep).length) return fs.rmSync(tabKeepFile(), { force: true });
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.writeFileSync(tabKeepFile(), safeStorage.encryptString(JSON.stringify(tabKeep)), { mode: 0o600 });
  } catch (e) { /* signing in again still works */ }
};
const tabKeepOrigin = wc => {
  try {
    const u = new URL(wc.getURL());
    if (u.protocol === 'https:' && /(^|\.)claralabs\.com$/i.test(u.hostname)) return u.origin;
    if (!app.isPackaged && process.env.NAV_TEST_MS && u.hostname === '127.0.0.1' && u.pathname.startsWith('/clara')) return u.origin;
  } catch (e) { /* not a page */ }
  return '';
};
// Clara keeps its sign-in at one of its addresses (app.claralabs.com) and shows a sign-in screen at its others
// (beta.claralabs.com), even while you are signed in. When a Clara page lands on a sign-in screen and a current
// sign-in is held for another Clara address, go there instead, and tell the window so it opens there from now on.
const claraMovedAt = new Map();
async function claraHome(wc, url) {
  try {
    const u = new URL(url), isClara = h => /(^|\.)claralabs\.com$/i.test(h);
    if (u.protocol !== 'https:' || !isClara(u.hostname) || !/\/(log-?in|sign-?in|auth)\b/i.test(u.pathname)) return;
    if (Date.now() - (claraMovedAt.get(wc.id) || 0) < 60000) return;          // (once a minute at most: never a loop)
    const now = Date.now() / 1000, all = await wc.session.cookies.get({ name: 'clara_access_token' });
    const c = all.find(x => isClara(String(x.domain).replace(/^\./, '')) && x.value && (!x.expirationDate || x.expirationDate > now + 60));
    if (!c) return;
    const host = String(c.domain).replace(/^\./, '');
    if (host === u.hostname || u.hostname.endsWith('.' + host)) return;      // the sign-in already covers this address: it really is signed out
    claraMovedAt.set(wc.id, Date.now()); mark('Clara: signed in at another address, going there');
    const home = `https://${host}/`;
    if (!wc.isDestroyed()) wc.loadURL(home).catch(() => {});
    send('clara-moved', home);
  } catch (e) { /* stays where it is */ }
}
async function tabKeepRestore(wc) {
  const o = tabKeepOrigin(wc); if (!o) return;
  const saved = tabKeepLoad()[o] || {};
  const n = await wc.executeJavaScript(`(d => { try { if (sessionStorage.getItem('__navKept')) return 0; sessionStorage.setItem('__navKept', '1'); let n = 0; for (const k in d) if (sessionStorage.getItem(k) === null) { sessionStorage.setItem(k, d[k]); n++; } return n; } catch (e) { return 0; } })(${JSON.stringify(saved)})`, true).catch(() => 0);
  if (n > 0 && !wc.isDestroyed()) wc.reload();      // the page reads its sign-in as it starts, so start it again
}
async function tabKeepSnap(wc) {
  if (!wc || wc.isDestroyed() || tabKeepReaders.has(wc.id)) return;
  const o = tabKeepOrigin(wc); if (!o) return;
  const d = await wc.executeJavaScript(`(() => { try { if (!sessionStorage.getItem('__navKept')) return null; const o = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k !== '__navKept') o[k] = sessionStorage.getItem(k); } return o; } catch (e) { return null; } })()`, true).catch(() => null);
  if (!d || typeof d !== 'object') return;
  const s = JSON.stringify(d); if (s.length > 400000) return;
  const all = tabKeepLoad(); if (JSON.stringify(all[o] || {}) === s) return;
  if (Object.keys(d).length) all[o] = d; else delete all[o];
  tabKeepSave();
}
setInterval(() => { try { webContents.getAllWebContents().forEach(wc => { tabKeepSnap(wc); }); } catch (e) { /* next time */ } }, 20000);

// ---------- monday.com ----------
ipcMain.handle('monday-status', () => ({ connected: monday.hasToken() }));
ipcMain.handle('monday-connect', async (_e, token) => {
  token = typeof token === 'string' ? token.trim() : '';
  if (token.length < 20) return { error: 'That does not look like a monday.com API token.' };
  try {
    const me = await monday.check(token);
    monday.saveToken(token);
    return { ok: true, me };
  } catch (e) {
    return { error: e.code === 'token' ? 'monday.com did not accept that token. Copy it again from Developers \u203a My access tokens.' : `Could not reach monday.com: ${e.message}` };
  }
});
ipcMain.handle('monday-disconnect', () => { monday.clearToken(); return { ok: true }; });
ipcMain.handle('monday-rename-board', async (_e, id, name) => {
  name = typeof name === 'string' ? name.trim() : '';
  if (!/^\d+$/.test(String(id)) || !name) return { error: 'Nothing to rename' };
  try { return await monday.renameBoard(id, name); } catch (e) { return { error: e.code === 'token' ? 'monday.com no longer accepts your token' : e.message }; }
});
ipcMain.handle('monday-delete-boards', async (_e, ids) => {
  const out = { deleted: [], failed: [] };
  for (const id of (Array.isArray(ids) ? ids : []).filter(x => /^\d+$/.test(String(x)))) {
    try { await monday.deleteBoard(id); out.deleted.push(String(id)); } catch (e) { out.failed.push({ id: String(id), status: e.message }); }
  }
  return out;
});
ipcMain.handle('monday-create-board', async (_e, opts) => {
  const name = opts && typeof opts.name === 'string' ? opts.name.trim() : '';
  if (!name) return { error: 'Give the board a name' };
  try { return { board: await monday.createBoard({ name, kind: opts.kind, workspace: opts.workspace, folder: opts.folder }) }; }
  catch (e) { return { error: e.code === 'token' ? 'monday.com no longer accepts your token; reconnect it' : e.message }; }
});
let mondayRun = null;
ipcMain.handle('monday-fetch', () => mondayRun || (mondayRun = monday.fetchAll()
  .catch(e => ({ connected: monday.hasToken(), error: e.code === 'token' ? 'token' : e.message }))
  .finally(() => { mondayRun = null; })));

// ---------- Automatic backups ----------
// One backup a day of your folders (and the app's links between chats and artifacts), the last 30 kept.
const backupDir = () => path.join(app.getPath('userData'), 'Backups');
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}\.json$/;
ipcMain.handle('backup-write', (_e, text) => {
  if (typeof text !== 'string' || text.length > 50e6) return { error: 'nothing to back up' };
  fs.mkdirSync(backupDir(), { recursive: true });
  const d = new Date();
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  const tmp = path.join(backupDir(), name + '.tmp');
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(backupDir(), name));
  const all = fs.readdirSync(backupDir()).filter(n => BACKUP_NAME.test(n)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 30))) fs.rmSync(path.join(backupDir(), old), { force: true });
  return { name };
});
ipcMain.handle('backup-list', () => {
  try {
    return fs.readdirSync(backupDir()).filter(n => BACKUP_NAME.test(n)).sort().reverse()
      .map(n => ({ name: n, size: fs.statSync(path.join(backupDir(), n)).size }));
  } catch (e) { return []; }
});
ipcMain.handle('backup-read', (_e, name) => {
  if (typeof name !== 'string' || !BACKUP_NAME.test(name)) return null;
  try { return fs.readFileSync(path.join(backupDir(), name), 'utf8'); } catch (e) { return null; }
});
ipcMain.handle('backup-reveal', () => { fs.mkdirSync(backupDir(), { recursive: true }); shell.openPath(backupDir()); });

// ---------- Messages from the folder page ----------
ipcMain.handle('open-external', (_e, url) => { if (httpUrl(url)) return shell.openExternal(url); });
// Starts an email in the Mac's mail app (used for Clara). Only mailto: links, and nothing that could attach files.
ipcMain.handle('open-mail', (_e, url) => {
  if (typeof url !== 'string' || !/^mailto:/i.test(url) || url.length > 8000 || /[?&](attach|attachment)=/i.test(url)) return false;
  // On a Mac, open it in the Outlook desktop app (Kevin's mail app), even if another app is the default for email.
  // If Outlook is not there, fall back to the default mail app.
  if (process.platform === 'darwin') {
    return new Promise(resolve => {
      require('child_process').execFile('/usr/bin/open', ['-b', 'com.microsoft.Outlook', url], err => {
        if (!err) return resolve(true);
        shell.openExternal(url).then(() => resolve(true), () => resolve(false));
      });
    });
  }
  return shell.openExternal(url).then(() => true, () => false);
});
// Clara: a new Outlook email from a chosen account, with Clara copied in. Outlook is told which account to send
// from (classic Outlook for Mac can be; if it cannot, or the account is not found, a plain new email opens and
// the app says which From to pick).
const CLARA_SCRIPT = `on run argv
  set fromAddr to item 1 of argv
  set ccAddr to item 2 of argv
  tell application "Microsoft Outlook"
    set acct to missing value
    repeat with a in ((exchange accounts) & (imap accounts) & (pop accounts))
      try
        set addr to (email address of a) as text
        if addr is fromAddr then set acct to (contents of a)
      end try
    end repeat
    if acct is missing value then error "no such account"
    set m to make new outgoing message with properties {account:acct}
    try
      make new cc recipient at m with properties {email address:{address:ccAddr}}
    on error errText
      delete m
      error errText
    end try
    open m
    activate
  end tell
  return "ok"
end run`;
// Mail and calendar accounts: sign-ins are kept in this process (see accounts.js); the window only gets names.
ipcMain.handle('acct-list', () => accounts.list());
ipcMain.handle('acct-add', (_e, hint, more) => accounts.add(typeof hint === 'string' ? hint : '', more === true));
ipcMain.handle('acct-remove', (_e, id) => accounts.remove(String(id)));
// Mail search: the index is kept by mailindex.js, in a process of its own.
ipcMain.handle('mailindex-boxes', (_e, list) => mailindex.setBoxes(list));
ipcMain.handle('mailindex-status', () => mailindex.status());
ipcMain.handle('mailindex-search', (_e, q, opt) => mailindex.search(q, opt && typeof opt === 'object' ? opt : {}));
ipcMain.handle('mailindex-reset', (_e, key) => mailindex.reset(String(key)));
ipcMain.handle('mailindex-sync', () => mailindex.syncNow());
ipcMain.handle('mailindex-pause', (_e, on) => mailindex.setPaused(on === true));
// Mail health: what has been asked of Microsoft lately and how it went (see maillog.js), for the Mail Health screen.
ipcMain.handle('mail-health', () => {
  const names = {}; for (const a of accounts.list()) names[a.id] = a.email;
  const h = maillog.health(names);
  for (const a of accounts.list()) if (!h.accounts.some(z => z.acc === a.id)) h.accounts.push({ acc: a.id, email: a.email, lastOk: 0, lastErr: '', lastErrAt: 0, n: 0, errs: 0, slow: 0, avg: 0, bg: 0, timeouts: 0 });
  for (const a of h.accounts) { a.queue = accounts.queueOf(a.acc); a.needsSignIn = !!(accounts.list().find(z => z.id === a.acc) || {}).needsSignIn; }
  h.index = mailindex.status(); h.version = app.getVersion(); h.online = net.isOnline();
  return h;
});
ipcMain.handle('mail-log-show', () => { try { shell.showItemInFolder(maillog.file()); } catch (e) { /* no log yet */ } return true; });
ipcMain.handle('acct-graph', (_e, id, req) => accounts.graph(String(id), req));
// Sending an email takes two steps, and both must come from the app's own window (never a web page inside it):
// 1. "arm": asked the instant Send is clicked. It is accepted only while the window reports a real click or key
//    press by a person in the last moments (a script cannot fake that), and it names the one draft to send.
// 2. "send": sends that one draft, once, within two minutes of the click.
let sendArmed = null;
const lastClicks = new Map();              // per window: the last real mouse release there: { x, y, at }
function watchRealClicks(win) {
  // The event says a mouse button was let go in this window; where the pointer really is comes from the system.
  win.webContents.on('input-event', (_e, ev) => {
    if (!ev || ev.type !== 'mouseUp' || win.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint(), cb = win.getContentBounds();
    lastClicks.set(win.webContents.id, { x: pt.x - cb.x, y: pt.y - cb.y, at: Date.now() });
  });
}
// The app's own windows: the main one, and any app you have opened in a window of its own.
const isOwnContents = wc => (!!mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents) || [...appWindows.values()].some(w => !w.isDestroyed() && w.webContents === wc);
const fromOwnWindow = e => isOwnContents(e.sender) && e.senderFrame === e.sender.mainFrame;
ipcMain.handle('acct-send-arm', async (e, id, msgId) => {
  sendArmed = null;
  if (!fromOwnWindow(e)) return { ok: false, error: 'Not allowed' };
  // A real mouse click, seen here (not reported by the page), in the last two seconds, that landed on the Send button.
  const c = lastClicks.get(e.sender.id) || null; lastClicks.delete(e.sender.id);
  let onSend = false;
  try {
    const z = e.sender.getZoomFactor() || 1;
    const q = await e.sender.executeJavaScript(`(() => { const b = document.querySelector('.mail-compose [data-x="send"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`, false);
    const r = q && { l: q.l * z, t: q.t * z, r: q.r * z, b: q.b * z };
    onSend = !!(c && r && Date.now() - c.at < 2000 && c.x >= r.l - 2 && c.x <= r.r + 2 && c.y >= r.t - 2 && c.y <= r.b + 2);
  } catch (err) { onSend = false; }
  // (Automated tests of the app run from source against a stand-in mail server, never Microsoft. Their clicks have no
  // system pointer, so there, and only there, a click the page vouches for is accepted.)
  if (!onSend && !app.isPackaged && process.env.NAV_TEST_MS && !process.env.NAV_LOCK_STRICT) {
    try { onSend = await e.sender.executeJavaScript('!!(navigator.userActivation && navigator.userActivation.isActive)', false); } catch (err) { onSend = false; }
  }
  if (!onSend) { maillog.add({ kind: 'lock', acc: String(id), error: 'Send was refused: no real click on the Send button was seen' }); return { ok: false, error: 'An email is only sent when you press Send yourself' }; }
  sendArmed = { id: String(id), msgId: String(msgId), until: Date.now() + 120e3 };
  return { ok: true };
});
ipcMain.handle('acct-send', async (e, id, msgId, box) => {
  const a = sendArmed; sendArmed = null;
  if (!fromOwnWindow(e) || !a || a.id !== String(id) || a.msgId !== String(msgId) || Date.now() > a.until) return { ok: false, error: 'An email is only sent when you press Send yourself' };
  return accounts.send(String(id), String(msgId), typeof box === 'string' ? box : '');
});
ipcMain.handle('acct-upload', (_e, url, bytes, start, total) => accounts.uploadPiece(url, bytes, start, total));
// An attachment is saved to Downloads; documents and pictures then open, anything else is shown in Finder.
ipcMain.handle('acct-attachment', async (_e, id, msgId, attId, name, box) => {
  const r = await accounts.saveAttachment(String(id), String(msgId), String(attId), String(name || ''), typeof box === 'string' ? box : '');
  if (!r.ok) return r;
  if (/\.(pdf|docx?|xlsx?|pptx?|csv|txt|rtf|png|jpe?g|gif|heic|webp|ics|pages|numbers|key|md)$/i.test(r.path)) shell.openPath(r.path); else shell.showItemInFolder(r.path);
  return r;
});

// Hand an email to staff: an attachment is saved (not opened) to Downloads, or to a holding folder from which the
// window copies it into the staff member's folder.
ipcMain.handle('acct-attachment-save', async (_e, id, msgId, attId, name, box, where) => {
  let dir = '';
  if (where === 'temp') { dir = path.join(app.getPath('temp'), 'claude-navigator-mail', String(Date.now())); fs.mkdirSync(dir, { recursive: true }); }
  else if (typeof where === 'string' && where.startsWith('downloads/')) {      // a folder of its own inside Downloads
    const sub = path.basename(where.slice(10)).replace(/[\/\\:*?"<>|\0]/g, ' ').replace(/^\.+/, '').trim().slice(0, 80);
    if (sub) { dir = path.join(app.getPath('downloads'), sub); fs.mkdirSync(dir, { recursive: true }); }
  }
  return accounts.saveAttachment(String(id), String(msgId), String(attId), String(name || ''), typeof box === 'string' ? box : '', dir);
});
ipcMain.handle('acct-message-save', async (_e, id, msgId, name, box, where) => {
  let dir = '';
  if (where === 'temp') { dir = path.join(app.getPath('temp'), 'claude-navigator-mail', String(Date.now())); fs.mkdirSync(dir, { recursive: true }); }
  return accounts.saveMime(String(id), String(msgId), String(name || ''), typeof box === 'string' ? box : '', dir);
});
ipcMain.handle('monday-board-info', async (_e, id) => { try { return { board: await monday.boardInfo(id) }; } catch (e) { return { error: e.code === 'token' ? 'monday.com no longer accepts your token; reconnect it' : e.message }; } });
ipcMain.handle('monday-create-item', async (_e, opts) => {
  if (!opts || !opts.board || !String(opts.name || '').trim()) return { error: 'Give the item a name' };
  try { return { item: await monday.createItem(opts) }; } catch (e) { return { error: e.code === 'token' ? 'monday.com no longer accepts your token; reconnect it' : e.message }; }
});
// A new Word document with words already in it (from an email, say), in one of your folders; then it opens in Word.
// (A .docx is a zip of a few small XML files; this writes the smallest valid one.)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return buf => { let c = 0xFFFFFFFF; for (const b of buf) c = t[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }; })();
function zipStore(files) {
  const parts = [], central = []; let at = 0;
  for (const [name, text] of files) {
    const nm = Buffer.from(name), data = Buffer.from(text), crc = CRC(data);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nm.length, 26);
    parts.push(head, nm, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(at, 42);
    central.push(c, nm);
    at += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, cd, end]);
}
ipcMain.handle('fs-new-docx', async (_e, destRel, name, paras) => {
  if (!folderSync) return { error: 'Folders on this Mac are not turned on' };
  const esc = t => String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = (Array.isArray(paras) ? paras : []).slice(0, 2000).map(p0 => {
    const o = p0 && typeof p0 === 'object' ? p0 : { text: String(p0 == null ? '' : p0) };
    const runs = String(o.text || '').split('\n').map((line, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(line)}</w:t>`).join('');
    const rpr = o.head ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : o.bold ? '<w:rPr><w:b/></w:rPr>' : o.grey ? '<w:rPr><w:color w:val="666666"/></w:rPr>' : '';
    return `<w:p><w:pPr><w:spacing w:after="${o.head ? 160 : 120}"/></w:pPr><w:r>${rpr}${runs}</w:r></w:p>`;
  }).join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const zip = zipStore([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', doc],
  ]);
  try {
    const dir = folderSync.abs(destRel || '');
    fs.mkdirSync(dir, { recursive: true });
    const stem = String(name || 'Untitled').replace(/[\/\\:*?"<>|\r\n]/g, '-').replace(/\.docx$/i, '').trim().slice(0, 120) || 'Untitled';
    let target = path.join(dir, `${stem}.docx`);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem} ${i}.docx`);
    fs.writeFileSync(target, zip);
    if (!process.env.NAV_TEST_MS) shell.openPath(target);
    return { ok: true, rel: folderSync.rel(target), name: path.basename(target) };
  } catch (e) { return { error: String(e && e.message || e) }; }
});
// (Tests point the drafting panel at a stand-in page instead of Claude. Never in the app you install.)
// The Mac's own dictation, started for whatever box has the cursor (the same as Edit > Start Dictation).
// The shape of an embedded page (tags, ids and class names only, never its words), so its extra bars can be
// hidden by name. Asked for by hand from the Notes menu.
ipcMain.handle('page-layout', async (e, id) => {
  if (!fromOwnWindow(e)) return '';
  const wc = webContents.fromId(Number(id));
  if (!wc || wc.hostWebContents !== e.sender) return '';
  const dump = `(() => { const out = []; const walk = (el, d) => { if (out.length > 500 || d > 26) return; const r = el.getBoundingClientRect();
    if (r.width >= 60 && r.height >= 16) { const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 4).join('.') : '';
      out.push(' '.repeat(Math.min(d, 20)) + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '') + (el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : '') + (el.shadowRoot ? ' {shadow}' : '') + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top)); }
    for (const c of el.children) walk(c, d + 1);
    if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, d + 1); }; if (document.body) walk(document.body, 0); return out.join('\\n'); })()`;
  const parts = [];
  for (const fr of wc.mainFrame.framesInSubtree) {
    try { let host = ''; try { host = new URL(fr.url).hostname; } catch (e2) { /* about:blank */ } parts.push('FRAME ' + host + '\n' + await fr.executeJavaScript(dump)); } catch (e2) { /* a frame that will not answer */ }
  }
  return parts.join('\n\n').slice(0, 60000);
});
// The team, for the phone: one small file per profile in iCloud Drive (Claude Navigator Phone), which Apple carries
// to your other devices. No server, and nothing leaves your Apple account. Written only when something changed.
function phoneDir() {
  const base = process.env.NAV_TEST_PHONE_DIR || (isMac ? path.join(app.getPath('home'), 'Library', 'Mobile Documents', 'com~apple~CloudDocs') : '');
  if (phoneDir.ok === base) return path.join(base, 'Claude Navigator Phone');      // (asked once: iCloud can be slow to answer)
  try { if (!base || !fs.statSync(base).isDirectory()) return ''; } catch (e) { return ''; }      // iCloud Drive is not switched on
  phoneDir.ok = base;
  return path.join(base, 'Claude Navigator Phone');
}
ipcMain.handle('phone-publish', async (e, docs) => {
  if (!fromOwnWindow(e) || !docs || typeof docs !== 'object') return { ok: false };
  const dir = phoneDir();
  if (!dir) return { ok: false, why: 'no-icloud' };
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const put = async (name, text) => { const f = path.join(dir, name); let old = null; try { old = await fs.promises.readFile(f, 'utf8'); } catch (e2) { /* new */ } if (old === text) return; await fs.promises.writeFile(f + '.tmp', text); await fs.promises.rename(f + '.tmp', f); };
    const index = [];
    for (const [pid, doc] of Object.entries(docs).slice(0, 40)) {
      if (!doc || typeof doc !== 'object' || !/^[A-Za-z0-9_-]{1,60}$/.test(pid)) continue;
      const name = `team-${pid}.json`;
      if (!doc.today) { try { const was = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8')); if (was && was.today) { doc.today = was.today; doc.todayAt = was.todayAt; } } catch (e2) { /* none yet */ } }
      const text = JSON.stringify(doc);
      if (text.length > 4e6) continue;
      await put(name, text);
      index.push({ id: pid, name: String((doc.profile || {}).name || ''), color: String((doc.profile || {}).color || ''), file: name });
    }
    await put('index.json', JSON.stringify({ v: 1, profiles: index }));
    return { ok: true, dir };
  } catch (err) { return { ok: false, why: String(err && err.message || err) }; }
});
// What you did on the phone (a new chat, an action ticked done, an output filed) arrives as a small file in the same
// iCloud Drive folder. The Mac reads it, applies each change once, and notes which ones it has applied.
ipcMain.handle('phone-changes', async (e) => {
  if (!fromOwnWindow(e)) return null;
  const dir = phoneDir(); if (!dir) return null;
  try { const t = await fs.promises.readFile(path.join(dir, 'phone-changes.json'), 'utf8'); return t.length < 2e6 ? JSON.parse(t) : null; } catch (err) { return null; }
});
ipcMain.handle('phone-applied', async (e, ids) => {
  if (!fromOwnWindow(e) || !Array.isArray(ids)) return false;
  const dir = phoneDir(); if (!dir) return false;
  try { const f = path.join(dir, 'mac-applied.json'); await fs.promises.mkdir(dir, { recursive: true }); await fs.promises.writeFile(f + '.tmp', JSON.stringify({ v: 1, ids: ids.filter(x => typeof x === 'string').slice(-800) })); await fs.promises.rename(f + '.tmp', f); return true; } catch (err) { return false; }
});
ipcMain.handle('dictation-start', () => { if (!isMac) return false; try { Menu.sendActionToFirstResponder('startDictation:'); return true; } catch (e) { return false; } });
// A profile's invite design (logo, shapes, fonts, colours) is a file kept on this Mac only, never in the app itself.
const inviteKitFile = pid => path.join(app.getPath('userData'), 'invite-kits', String(pid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) + '.json');
ipcMain.handle('invite-kit-get', (e, pid) => { if (!fromOwnWindow(e) || !pid) return ''; try { return fs.readFileSync(inviteKitFile(pid), 'utf8'); } catch (er) { return ''; } });
ipcMain.handle('invite-kit-set', (e, pid, text) => {
  if (!fromOwnWindow(e) || !pid || typeof text !== 'string' || text.length > 12e6) return false;
  try { const k = JSON.parse(text); if (!k || k.v !== 1) return false; fs.mkdirSync(path.dirname(inviteKitFile(pid)), { recursive: true }); fs.writeFileSync(inviteKitFile(pid), text); return true; } catch (er) { return false; }
});
// ----- The Mac's own writing model (Apple Intelligence), through the small helper beside the app -----
// Used for a first draft of an email, at once and without leaving the Mac. It only returns words: nothing is sent.
const localAi = { proc: null, buf: '', waitStatus: [], owners: new Map(), status: null };
function localAiPath() {
  if (!app.isPackaged && process.env.NAV_TEST_LOCALAI) return { cmd: process.execPath, args: [process.env.NAV_TEST_LOCALAI], env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) };
  if (!isMac) return null;
  const file = app.isPackaged ? path.join(process.resourcesPath, 'navdraft') : path.join(__dirname, 'build', 'navdraft');
  return fs.existsSync(file) ? { cmd: file, args: [], env: process.env } : null;
}
function localAiStart() {
  if (localAi.proc) return localAi.proc;
  const how = localAiPath(); if (!how) return null;
  let p;
  try { p = require('child_process').spawn(how.cmd, how.args, { env: how.env, stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) { return null; }
  localAi.proc = p; localAi.buf = '';
  const gone = () => {
    if (localAi.proc !== p) return;
    localAi.proc = null; localAi.status = null;
    for (const w of localAi.waitStatus.splice(0)) w({ ok: false, reason: 'The helper stopped.' });
    for (const [id, wc] of localAi.owners) { try { if (!wc.isDestroyed()) wc.send('local-ai', { id, error: 'The helper stopped.' }); } catch (e) { /* window closed */ } }
    localAi.owners.clear();
  };
  p.on('error', gone); p.on('exit', gone); p.stdin.on('error', () => {});
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', chunk => {
    localAi.buf += chunk; let i;
    while ((i = localAi.buf.indexOf('\n')) >= 0) {
      const line = localAi.buf.slice(0, i); localAi.buf = localAi.buf.slice(i + 1);
      let o = null; try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o) continue;
      if (o.status) { const r = { ok: o.status === 'ok', reason: String(o.reason || '') }; localAi.status = r; for (const w of localAi.waitStatus.splice(0)) w(r); continue; }
      const wc = localAi.owners.get(o.id); if (!wc) continue;
      if (o.done || o.error || o.listenDone) localAi.owners.delete(o.id);
      try { if (!wc.isDestroyed()) wc.send('local-ai', { id: String(o.id), text: typeof o.text === 'string' ? o.text : undefined, done: !!o.done, error: o.error ? String(o.error).slice(0, 400) : undefined, heard: typeof o.heard === 'string' ? o.heard : undefined, listening: !!o.listening, listenDone: !!o.listenDone, note: o.note ? String(o.note) : undefined }); } catch (e) { /* window closed */ }
    }
  });
  return p;
}
const localAiSay = o => { const p = localAiStart(); if (!p) return false; try { p.stdin.write(JSON.stringify(o) + '\n'); return true; } catch (e) { return false; } };
ipcMain.handle('local-ai-status', e => {
  if (!fromOwnWindow(e)) return { ok: false, reason: '' };
  if (localAi.status && localAi.status.ok) return localAi.status;
  if (!localAiPath()) return { ok: false, reason: 'missing' };
  return new Promise(resolve => {
    const done = r => { clearTimeout(t); resolve(r); };
    const t = setTimeout(() => { localAi.waitStatus = localAi.waitStatus.filter(w => w !== done); resolve({ ok: false, reason: 'no answer' }); }, 6000);
    localAi.waitStatus.push(done);
    if (!localAiSay({ op: 'status' })) done({ ok: false, reason: 'could not start' });
  });
});
ipcMain.handle('local-ai-run', (e, id, instructions, prompt) => {
  if (!fromOwnWindow(e) || typeof id !== 'string' || !id || id.length > 60) return false;
  localAi.owners.set(id, e.sender);
  const ok = localAiSay({ op: 'run', id, instructions: String(instructions || '').slice(0, 6000), prompt: String(prompt || '').slice(0, 24000) });
  if (!ok) localAi.owners.delete(id);
  return ok;
});
ipcMain.handle('local-ai-cancel', (e, id) => { if (!fromOwnWindow(e)) return false; localAi.owners.delete(String(id)); return localAiSay({ op: 'cancel', id: String(id) }); });
// Dictation through the same helper (the Mac's newer speech engine: no chime, words as you say them).
ipcMain.handle('local-listen-start', (e, id, locale, names) => {
  if (!fromOwnWindow(e) || typeof id !== 'string' || !id || id.length > 60) return false;
  localAi.owners.set(id, e.sender);
  const ok = localAiSay({ op: 'listen', id, locale: /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(String(locale)) ? String(locale) : 'en-AU', names: (Array.isArray(names) ? names : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 100).map(x => x.trim().slice(0, 60)) });
  if (!ok) localAi.owners.delete(id);
  return ok;
});
ipcMain.handle('local-listen-stop', (e, id) => (fromOwnWindow(e) ? localAiSay({ op: 'stopListen', id: String(id) }) : false));
app.on('will-quit', () => { try { if (localAi.proc) localAi.proc.kill(); } catch (e) { /* already gone */ } });

// Clara's own dashboard is where her work really stands. It is read here, signed in as you already are in the app,
// and only read: nothing on the page is pressed or changed.
ipcMain.handle('clara-read', async (e, url) => {
  if (!fromOwnWindow(e)) return null;
  let u; try { u = new URL(String(url)); } catch (er) { return null; }
  const test = !app.isPackaged && process.env.NAV_TEST_MS && u.hostname === '127.0.0.1';
  if (!test && !(u.protocol === 'https:' && /(^|\.)claralabs\.com$/.test(u.hostname))) return null;
  const win = new BrowserWindow({ show: false, width: 1280, height: 1500, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  const rid = win.webContents.id; tabKeepReaders.add(rid);
  const guard = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 60000);
  try {
    await win.loadURL(u.href).catch(() => {});
    const read = () => win.webContents.executeJavaScript('document.body ? document.body.innerText : ""', true).catch(() => '');
    // (a sign-in page only counts once it has stayed for five seconds: Clara shows one for a moment while it signs you in)
    let text = '', asked = 0;
    for (let i = 0; i < 44 && !win.isDestroyed(); i++) {
      text = String(await read() || '');
      if (/Updated .{1,30} ago|In-Progress|No (events|commands)/i.test(text)) break;
      if (/Sign in|Log in|Continue with/i.test(text)) { if (++asked >= 10) break; } else asked = 0;
      await sleep(500);
    }
    for (let i = 0; i < 4 && !win.isDestroyed(); i++) { await win.webContents.executeJavaScript('window.scrollTo(0, document.documentElement.scrollHeight); for (const el of document.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 300) el.scrollTop = el.scrollHeight; 1', true).catch(() => {}); await sleep(700); }
    if (!win.isDestroyed()) text = String(await read() || text);
    return { text: text.slice(0, 200000), url: win.isDestroyed() ? '' : win.webContents.getURL() };
  } finally { clearTimeout(guard); tabKeepReaders.delete(rid); if (!win.isDestroyed()) win.destroy(); }
});
// What Clara keeps to remember your sign-in: names and lifetimes only, never the values. For working out why a sign-in is lost.
ipcMain.handle('clara-signin-info', async e => {
  if (!fromOwnWindow(e)) return '';
  const L = [`Claude Navigator ${app.getVersion()}`];
  try {
    const all = await session.fromPartition(PARTITION).cookies.get({});
    const mine = all.filter(c => /clara/i.test(c.domain || ''));
    L.push(`Cookies for Clara: ${mine.length}`);
    for (const c of mine.slice(0, 40)) L.push(`  ${c.name} (${c.domain}) ${c.session ? 'ends when the app quits' : 'lasts ' + Math.round((c.expirationDate - Date.now() / 1000) / 3600) + ' h'}${c.httpOnly ? ', httpOnly' : ''}`);
  } catch (er) { L.push('Cookies: could not read'); }
  const kept = tabKeepLoad();
  L.push(`Kept tab sign-ins: ${Object.keys(kept).map(o => `${o} (${Object.keys(kept[o]).join(', ').slice(0, 300)})`).join('; ') || 'none'}`);
  let pages = 0;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed() || !tabKeepOrigin(wc)) continue;
    pages++;
    const r = await wc.executeJavaScript(`(async () => { const keys = s => { try { return Object.keys(s).map(k => k + ' [' + String(s.getItem(k) || '').length + ']').join(', ').slice(0, 1200); } catch (e) { return 'blocked'; } }; let dbs = ''; try { dbs = (await indexedDB.databases()).map(d => d.name).join(', '); } catch (e) { dbs = 'unknown'; } return { url: location.origin + location.pathname, signIn: /sign in|log in|continue with/i.test(document.body ? document.body.innerText.slice(0, 3000) : ''), tab: keys(sessionStorage), local: keys(localStorage), dbs }; })()`, true).catch(() => null);
    if (!r) { L.push('A Clara page could not be read'); continue; }
    L.push(`Page: ${r.url}${r.signIn ? ' (showing a sign-in screen)' : ''}`, `  Kept in the tab: ${r.tab || 'nothing'}`, `  Kept by the site: ${r.local || 'nothing'}`, `  Databases: ${r.dbs || 'none'}`);
  }
  if (!pages) L.push('No Clara page is open. Open the Scheduling tab first.');
  return L.join('\n');
});
// What Granola keeps on this Mac: file names, sizes, and the shape of its data (field names, counts and lengths).
// Never any meeting content, titles, names or sign-in values. For working out how the app can read meeting notes.
// ---------- Claude's API, the fast model only ----------
// Quick questions in the Chief of Staff panel can be answered through your own API key instead of driving Claude's
// page. One model, fixed here: there is no setting that reaches a dearer one. The key is encrypted with the Mac's
// Keychain in the app's own data folder; the window can save or remove it but can never read it back.
const API_MODEL = 'claude-haiku-5-5';
const apiKeyFile = () => path.join(app.getPath('userData'), 'api-key.bin');
const apiKeyGet = () => { try { return safeStorage.decryptString(fs.readFileSync(apiKeyFile())); } catch (e) { return ''; } };
const apiBase = () => (!app.isPackaged && process.env.NAV_TEST_API) || 'https://api.anthropic.com';
ipcMain.handle('api-status', e => (fromOwnWindow(e) ? { hasKey: !!apiKeyGet(), model: API_MODEL } : null));
ipcMain.handle('api-key-set', (e, key) => {
  if (!fromOwnWindow(e)) return false;
  key = String(key || '').trim();
  try {
    if (!key) { fs.rmSync(apiKeyFile(), { force: true }); return true; }
    if (key.length > 400 || /\s/.test(key) || !safeStorage.isEncryptionAvailable()) return false;
    fs.writeFileSync(apiKeyFile(), safeStorage.encryptString(key), { mode: 0o600 });
    return true;
  } catch (er) { return false; }
});
ipcMain.handle('api-ask', async (e, system, turns, max) => {
  if (!fromOwnWindow(e)) return null;
  const key = apiKeyGet(); if (!key) return { error: 'no key' };
  const messages = [];
  for (const t of (Array.isArray(turns) ? turns : []).slice(-8)) { if (!t || (t.role !== 'user' && t.role !== 'assistant') || typeof t.text !== 'string' || !t.text) continue; if (messages.length && messages[messages.length - 1].role === t.role) continue; messages.push({ role: t.role, content: t.text.slice(0, 20000) }); }
  if (!messages.length || messages[0].role !== 'user' || messages[messages.length - 1].role !== 'user') return { error: 'nothing to ask' };
  const started = Date.now(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await net.fetch(apiBase() + '/v1/messages', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' },
      body: JSON.stringify({ model: API_MODEL, max_tokens: Math.max(64, Math.min(800, +max || 320)), system: String(system || '').slice(0, 12000), messages, thinking: { type: 'disabled' }, output_config: { effort: 'low' } }) });
    const j = await r.json().catch(() => ({})), ms = Date.now() - started, u = j.usage || {};
    if (!r.ok) return { error: String((j.error && j.error.message) || `the API answered ${r.status}`).slice(0, 200), status: r.status, ms };
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (j.stop_reason === 'refusal' || !text) return { error: j.stop_reason === 'refusal' ? 'declined' : 'empty answer', ms, in: u.input_tokens || 0, out: u.output_tokens || 0 };
    return { text, ms, in: u.input_tokens || 0, out: u.output_tokens || 0, model: j.model || '' };
  } catch (er) { return { error: ctl.signal.aborted ? 'no answer in 30 seconds' : String(er && er.message || er).slice(0, 160), ms: Date.now() - started }; }
  finally { clearTimeout(timer); }
});
ipcMain.handle('granola-check', async e => {
  if (!fromOwnWindow(e)) return '';
  const L = [`Claude Navigator ${app.getVersion()}: Granola check (names, counts and lengths only; no meeting content)`];
  const home = app.getPath('home'), tidy = p => p.replace(home, '~');
  try { const pl = fs.readFileSync('/Applications/Granola.app/Contents/Info.plist', 'utf8'), m = /CFBundleShortVersionString<\/key>\s*<string>([^<]+)/.exec(pl); L.push(`Granola app: installed${m ? ', version ' + m[1] : ''}`); } catch (er) { L.push('Granola app: not found in Applications'); }
  const dir = process.env.NAV_TEST_GRANOLA && !app.isPackaged ? process.env.NAV_TEST_GRANOLA : path.join(app.getPath('appData'), 'Granola');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (er) { L.push(`Granola’s folder: not found (${tidy(dir)}): ${er.code || 'could not open'}`); return L.join('\n'); }
  L.push(`Granola’s folder: ${tidy(dir)}, ${names.length} items`);
  const field = k => /^[A-Za-z_][A-Za-z0-9_.-]{0,40}$/.test(k) && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k);
  const kind = v => v === null ? 'empty' : Array.isArray(v) ? `list of ${v.length}` : typeof v === 'string' ? `text(${v.length})` : typeof v === 'object' ? `group of ${Object.keys(v).length}` : typeof v;
  const out = []; const say = (d, t) => { if (out.length < 260) out.push('  '.repeat(d) + t); };
  // the fields a set of like things share, with how long their text usually is; and the span of any dates
  const shape = (items, d) => {
    const objs = items.filter(x => x && typeof x === 'object' && !Array.isArray(x)).slice(0, 40); if (!objs.length) { if (items.length) say(d, `each: ${kind(items[0])}`); const lists = items.filter(Array.isArray).slice(0, 20); if (lists.length) { say(d, `each a list, about ${Math.round(lists.reduce((a, x) => a + x.length, 0) / lists.length)} long`); shape([].concat(...lists.map(x => x.slice(0, 10))), d + 1); } return; }
    const F = {};
    for (const o of objs) for (const [k, v] of Object.entries(o)) { if (!field(k)) continue; const f = F[k] = F[k] || { n: 0, kinds: new Set(), len: 0, sub: [] }; f.n++; f.kinds.add(v === null ? 'empty' : Array.isArray(v) ? 'list' : typeof v); if (typeof v === 'string') f.len = Math.max(f.len, v.length); if (Array.isArray(v)) f.len = Math.max(f.len, v.length); if (v && typeof v === 'object' && f.sub.length < 6) f.sub.push(v); }
    for (const [k, f] of Object.entries(F).slice(0, 60)) { say(d, `${k}: ${[...f.kinds].join('/')}${f.len ? ' up to ' + f.len : ''}${f.n < objs.length ? ` (in ${f.n} of ${objs.length})` : ''}`); if (d < 9 && f.sub.length) { const lists = f.sub.filter(Array.isArray); if (lists.length) shape([].concat(...lists.map(x => x.slice(0, 10))), d + 1); else if (f.sub.every(x => Object.keys(x).every(field)) ) shape(f.sub, d + 1); else say(d + 1, `${Object.keys(f.sub[0]).length} entries`); } }
    const dates = []; for (const o of items.slice(0, 5000)) if (o && typeof o === 'object') for (const k of ['created_at', 'updated_at', 'start', 'start_time', 'date']) { const t = typeof o[k] === 'string' ? Date.parse(o[k]) : NaN; if (!isNaN(t)) { dates.push(t); break; } }
    if (dates.length) say(d, `dates from ${new Date(Math.min(...dates)).toISOString().slice(0, 10)} to ${new Date(Math.max(...dates)).toISOString().slice(0, 10)}`);
  };
  const walk = (v, d, name) => {
    if (typeof v === 'string' && d < 6 && v.length > 1 && /^[{\[]/.test(v)) { try { const inner = JSON.parse(v); say(d, `${name}: text holding data (${v.length} characters)`); return walk(inner, d + 1, 'inside'); } catch (er) { /* plain text */ } }
    if (Array.isArray(v)) { say(d, `${name}: list of ${v.length}`); return shape(v, d + 1); }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length > 40 || (keys.length > 3 && keys.filter(field).length < keys.length / 2)) { say(d, `${name}: ${keys.length} entries`); return shape(Object.values(v), d + 1); }
      say(d, `${name}: group of ${keys.length}`);
      if (d < 8) for (const k of keys) { if (!field(k)) continue; const x = v[k]; if (x && typeof x === 'object' || (typeof x === 'string' && x.length > 200 && /^[{\[]/.test(x))) walk(x, d + 1, k); else say(d + 1, `${k}: ${kind(x)}`); }
      return;
    }
    say(d, `${name}: ${kind(v)}`);
  };
  for (const n of names.slice(0, 80)) {
    let st; try { st = fs.statSync(path.join(dir, n)); } catch (er) { continue; }
    const secret = /token|auth|supabase|credential|cookie|session|key/i.test(n);
    L.push(`  ${n}${st.isDirectory() ? '/' : ''}  ${st.isDirectory() ? '' : Math.round(st.size / 1024) + ' KB'}  changed ${new Date(st.mtimeMs).toISOString().slice(0, 10)}${secret ? '  (sign-in file: not opened)' : ''}`);
    if (st.isDirectory() || secret || !/\.json$/i.test(n) || st.size > 400e6 || st.size < 2) continue;
    try { const data = JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8')); out.length = 0; walk(data, 2, 'contents'); L.push(...out); }
    catch (er) { L.push(`    could not be read as data: ${String(er.message || er).slice(0, 80)}`); }
  }
  return L.join('\n').slice(0, 60000);
});
// Granola: sign in to its own connection, and check what it can see.
ipcMain.handle('granola-status', e => (fromOwnWindow(e) ? granola.status() : { connected: false }));
ipcMain.handle('granola-connect', e => (fromOwnWindow(e) ? granola.connect() : { ok: false, status: 'not allowed' }));
ipcMain.handle('granola-test', e => (fromOwnWindow(e) ? granola.test() : { connected: false }));
const granRead = async (e, name, args) => { if (!fromOwnWindow(e)) return { ok: false, status: 'not allowed' }; try { return { ok: true, text: await granola.call(name, args) }; } catch (er) { return { ok: false, status: String(er && er.message || er) }; } };
ipcMain.handle('granola-meetings', (e, from, to) => (fromOwnWindow(e) && /^\d{4}-\d\d-\d\d$/.test(from) && /^\d{4}-\d\d-\d\d$/.test(to) ? granola.meetings(from, to).then(text => ({ ok: true, text }), er => ({ ok: false, status: String(er && er.message || er) })) : { ok: false, status: 'bad dates' }));
ipcMain.handle('granola-meeting', (e, id) => (/^[\w-]{6,80}$/.test(String(id)) ? granRead(e, 'get_meetings', { meeting_ids: [String(id)], attachments: 'none', max_participants: 10 }) : { ok: false, status: 'bad id' }));
ipcMain.handle('granola-transcript', (e, id) => (/^[\w-]{6,80}$/.test(String(id)) ? granRead(e, 'get_meeting_transcript', { meeting_id: String(id) }) : { ok: false, status: 'bad id' }));
ipcMain.handle('granola-ask', (e, q) => (typeof q === 'string' && q.length > 2 && q.length < 4000 ? granRead(e, 'query_granola_meetings', { query: q }) : { ok: false, status: 'bad question' }));
ipcMain.handle('granola-disconnect', e => (fromOwnWindow(e) ? granola.disconnect() : { connected: false }));
ipcMain.handle('test-ai-url', () => (!app.isPackaged && process.env.NAV_TEST_AI ? String(process.env.NAV_TEST_AI) : ''));
ipcMain.handle('mailindex-texts', (_e, keys) => mailindex.texts(Array.isArray(keys) ? keys.slice(0, 40).map(String) : []));
// Calendar: read a published calendar (an Outlook ICS link). Only web addresses; at most 15 MB; 25 seconds.
ipcMain.handle('cal-fetch', async (_e, url) => {
  if (typeof url !== 'string') return { ok: false, status: 'no link' };
  const u = url.trim().replace(/^webcals?:\/\//i, 'https://');
  if (!/^https:\/\//i.test(u)) return { ok: false, status: 'The link must start with https:// or webcal://' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await net.fetch(u, { signal: ctl.signal, headers: { Accept: 'text/calendar, */*' } });
    if (!res.ok) return { ok: false, status: `The calendar answered ${res.status}` };
    const text = await res.text();
    if (text.length > 15e6) return { ok: false, status: 'That calendar is too large' };
    if (!/BEGIN:VCALENDAR/i.test(text)) return { ok: false, status: 'That link is not a calendar (ICS) link' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, status: ctl.signal.aborted ? 'The calendar took too long to answer' : String(e && e.message || e) };
  } finally { clearTimeout(timer); }
});
ipcMain.handle('clara-mail', async (_e, opts) => {
  const ok = s => typeof s === 'string' && s.length < 200 && /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(s);
  const from = opts && opts.from, cc = opts && opts.cc;
  if (!ok(cc)) return false;
  const mailto = `mailto:?cc=${encodeURIComponent(cc)}`;
  const plain = () => new Promise(resolve => {
    if (process.platform !== 'darwin') return shell.openExternal(mailto).then(() => resolve('mailto'), () => resolve(false));
    require('child_process').execFile('/usr/bin/open', ['-b', 'com.microsoft.Outlook', mailto], err => {
      if (!err) return resolve('mailto');
      shell.openExternal(mailto).then(() => resolve('mailto'), () => resolve(false));
    });
  });
  if (process.platform !== 'darwin' || !ok(from)) return plain();
  const viaScript = await new Promise(resolve => {
    require('child_process').execFile('/usr/bin/osascript', ['-e', CLARA_SCRIPT, from, cc], { timeout: 10000 }, (err, out) => resolve(!err && /ok/.test(String(out))));
  });
  return viaScript ? 'account' : plain();
});
const inDownloads = f => {
  if (typeof f !== 'string') return false;
  const d = path.resolve(app.getPath('downloads')), p = path.resolve(f);
  if (d === path.resolve(app.getPath('home'))) return false;     // no real Downloads folder: allow nothing
  return p.startsWith(d + path.sep);
};
ipcMain.handle('open-window', (_e, url) => { if (httpUrl(url)) openChildWindow(url); });
ipcMain.handle('show-in-folder', (_e, file) => { if (inDownloads(file)) shell.showItemInFolder(path.resolve(file)); });
ipcMain.handle('open-file', (_e, file) => {
  if (!inDownloads(file) || /\.(app|command|sh|pkg|terminal|workflow|scpt)$/i.test(file)) return;   // never start programs
  return shell.openPath(path.resolve(file));
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
  mark('program read', (() => { try { return Math.round(Date.now() - process.getCreationTime()); } catch (e) { return null; } })());
  app.whenReady().then(() => {
    mark('system ready');
    timed('keep sign-ins', () => { try { keepSignIns(); } catch (e) { /* sign-ins then behave as before */ } });
    const syncSettings = readSyncSettings();
    if (syncSettings.enabled) timed('watch the synced folder', () => { try { startSync(syncSettings.root || defaultRoot()); } catch (e) { /* folder unavailable */ } });
    timed('set up session', setUpSession);
    timed('menu', buildMenu);
    timed('make window', createWindow);
    setUpUpdates();
    setUpLivePreview();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
}


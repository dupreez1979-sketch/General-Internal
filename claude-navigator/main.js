// Claude Navigator desktop app.
// Left: your own folder tree (index.html). Right: the real claude.ai, signed in,
// shown in a <webview> so every Claude feature (projects, artifacts, connectors,
// Canva, design systems) works exactly as it does in the browser.

const {
  app, BrowserWindow, ipcMain, shell, Menu, clipboard, session, systemPreferences, webContents,
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
        { label: 'Hide or Show Claude\u2019s Own Sidebar', click: act('toggle-claude-sidebar') },
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

// ---------- Claude Library: read your chats, projects and artifacts ----------
// Claude has no public API for this, so the app asks claude.ai the same way its own
// Recents page does, using your signed-in session. If that ever stops working, it
// falls back to reading the links Claude shows on its Recents and Artifacts pages.

const LIB_PATTERNS = {
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
    out.push({ url, name: (lines[0] || '').slice(0, 200) });
  }
  return out;
}`;

// Scrolls a claude.ai list page to the bottom (clicking "Show more") while collecting links.
const scrollHarvest = (pattern) => `(async () => {
  const collect = ${COLLECT_FN};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const found = new Map();
  let stable = 0;
  for (let i = 0; i < 90 && stable < 4; i++) {
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
    if (found.size === before && (found.size > 0 || i > 15)) stable++; else stable = 0;
  }
  return [...found.values()];
})()`;

// Asks claude.ai for the full lists, as its own pages do.
const API_SCRIPT = `(async () => {
  const out = { chats: [], projects: [], notes: [], status: 0 };
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
            starred: !!c.is_starred,
          });
          if (page.length < 200 || !fresh.length) break;
        }
      } catch (e) { out.notes.push('chats: ' + e.message); }
      try {
        for (const p of list(await get('/api/organizations/' + o.uuid + '/projects'))) {
          if (p && p.uuid) out.projects.push({ name: p.name || 'Untitled project', url: 'https://claude.ai/project/' + p.uuid, updated: p.updated_at || p.created_at || null });
        }
      } catch (e) { out.notes.push('projects: ' + e.message); }
    }
  } catch (e) { out.notes.push(e.message); }
  out.chats.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  out.projects.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  return out;
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openHidden(win, url) {
  await win.loadURL(url).catch(() => {}); // redirects can reject; the page still loads
  for (let i = 0; i < 40 && !win.isDestroyed(); i++) {
    if (!/just a moment|checking your browser/i.test(win.webContents.getTitle())) break;
    await sleep(500);
  }
  await sleep(1500);
}

async function fetchLibrary() {
  const result = { signedIn: true, chats: [], projects: [], artifacts: [], notes: [] };
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.setAudioMuted(true);
  const guard = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 150000);
  try {
    await openHidden(win, 'https://claude.ai/recents');
    if (/\/(login|logout|signup)/.test(win.webContents.getURL())) { result.signedIn = false; return result; }

    const api = await win.webContents.executeJavaScript(API_SCRIPT, true);
    result.chats = api.chats;
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
  } catch (e) {
    result.notes.push(String(e && e.message || e));
  } finally {
    clearTimeout(guard);
    if (!win.isDestroyed()) win.destroy();
  }
  return result;
}

let libraryRun = null;
ipcMain.handle('library-refresh', () => libraryRun || (libraryRun = fetchLibrary().finally(() => { libraryRun = null; })));

// Quick look at the links Claude is showing in the visible pane (its sidebar of recent chats).
ipcMain.handle('harvest-pane', async (_e, id, kind) => {
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed() || !isClaudeHost(wc.getURL()) || !LIB_PATTERNS[kind]) return [];
  return wc.executeJavaScript(`(${COLLECT_FN})(${JSON.stringify(LIB_PATTERNS[kind])})`, true).catch(() => []);
});

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


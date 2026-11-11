// monday.com: reads your workspaces, folders and boards with monday.com's official API, using a personal
// API token you paste into the app once. The token is encrypted with your Mac's Keychain (Electron safeStorage)
// and never leaves the main process: the folder page only ever sees the list of boards.

const fs = require('fs');
const path = require('path');
const { app, safeStorage, net } = require('electron');

// (Tests of the app run from source can point this at a stand-in. Never in the app you install.)
const API = (!app.isPackaged && process.env.NAV_TEST_MONDAY) || 'https://api.monday.com/v2';
const tokenFile = () => path.join(app.getPath('userData'), 'monday-token.bin');

function saveToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('This Mac cannot store the token securely right now');
  fs.writeFileSync(tokenFile(), safeStorage.encryptString(token), { mode: 0o600 });
}
function readToken() {
  try { return safeStorage.decryptString(fs.readFileSync(tokenFile())); } catch (e) { return null; }
}
function clearToken() { try { fs.rmSync(tokenFile(), { force: true }); } catch (e) { /* ignore */ } }
const hasToken = () => !!readToken();

async function gql(token, query, variables = {}) {
  const res = await net.fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-10' },
    body: JSON.stringify({ query, variables }),
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('monday.com did not accept the token'), { code: 'token' });
  if (!res.ok) throw new Error(`monday.com answered ${res.status}`);
  if (body && body.errors && body.errors.length) throw new Error(body.errors.map(e => e.message).join('; '));
  if (body && body.error_message) throw new Error(body.error_message);
  return (body && body.data) || {};
}

// Checks a token and returns who it belongs to.
async function check(token) {
  const d = await gql(token, 'query { me { name email account { name slug } } }');
  if (!d.me) throw Object.assign(new Error('monday.com did not accept the token'), { code: 'token' });
  return { name: d.me.name, email: d.me.email, account: d.me.account && d.me.account.name, slug: d.me.account && d.me.account.slug };
}

// Everything the sidebar shows: workspaces, the folders inside them, and active boards (sub-item boards left out).
async function fetchAll() {
  const token = readToken();
  if (!token) return { connected: false };
  const me = await check(token);
  const workspaces = [];
  for (let page = 1; page <= 20; page++) {
    const ws = await gql(token, 'query ($page: Int!) { workspaces(limit: 100, page: $page) { id name kind state } }', { page });
    const list = ws.workspaces || [];
    for (const w of list) if (w && w.id != null && w.state !== 'deleted' && w.state !== 'archived') workspaces.push({ id: String(w.id), name: w.name, kind: w.kind });
    if (list.length < 100) break;
  }
  const boards = [];
  for (let page = 1; page <= 40; page++) {
    const d = await gql(token, `query ($page: Int!) { boards(limit: 200, page: $page, state: active) {
      id name type board_kind workspace_id board_folder_id url updated_at } }`, { page });
    const list = d.boards || [];
    for (const b of list) {
      if (!b || b.type === 'sub_items_board') continue;
      boards.push({
        id: String(b.id), name: b.name, type: b.type || 'board', private: b.board_kind === 'private',
        workspace: b.workspace_id != null ? String(b.workspace_id) : 'main',
        folder: b.board_folder_id != null ? String(b.board_folder_id) : null,
        url: b.url || (me.slug ? `https://${me.slug}.monday.com/boards/${b.id}` : `https://monday.com/boards/${b.id}`),
        updated: b.updated_at || null,
      });
    }
    if (list.length < 200) break;
  }
  const folders = [];
  const ids = workspaces.map(w => w.id);
  for (let i = 0; i < ids.length; i += 25) {
    try {
      const d = await gql(token, `query ($ws: [ID]) { folders(limit: 100, workspace_ids: $ws) { id name workspace { id } parent { id } } }`, { ws: ids.slice(i, i + 25) });
      for (const f of d.folders || []) {
        if (f) folders.push({ id: String(f.id), name: f.name, workspace: f.workspace ? String(f.workspace.id) : 'main', parent: f.parent ? String(f.parent.id) : null });
      }
    } catch (e) { /* folders are a nice-to-have: boards still show at the workspace level */ }
  }
  if (boards.some(b => b.workspace === 'main') && !workspaces.some(w => w.id === 'main')) workspaces.unshift({ id: 'main', name: 'Main workspace', kind: 'open' });
  return { connected: true, me, workspaces, folders, boards, fetchedAt: Date.now() };
}

// Makes a new board (in a workspace, and optionally a folder) and returns it in the same shape as fetchAll's boards.
async function createBoard({ name, kind, workspace, folder }) {
  const token = readToken();
  if (!token) throw new Error('monday.com is not connected');
  const d = await gql(token, `mutation ($n: String!, $k: BoardKind!, $w: ID, $f: ID) {
    create_board(board_name: $n, board_kind: $k, workspace_id: $w, folder_id: $f) { id name url type workspace_id board_folder_id } }`,
  { n: String(name).slice(0, 255), k: ['public', 'private', 'share'].includes(kind) ? kind : 'public',
    w: workspace && workspace !== 'main' ? workspace : null, f: folder || null });
  const b = d.create_board;
  if (!b) throw new Error('monday.com did not create the board');
  return { id: String(b.id), name: b.name, type: b.type || 'board', private: kind === 'private',
    workspace: b.workspace_id != null ? String(b.workspace_id) : 'main', folder: b.board_folder_id != null ? String(b.board_folder_id) : null,
    url: b.url, updated: new Date().toISOString() };
}

async function renameBoard(id, name) {
  const token = readToken();
  if (!token) throw new Error('monday.com is not connected');
  await gql(token, 'mutation ($id: ID!, $v: String!) { update_board(board_id: $id, board_attribute: name, new_value: $v) }', { id: String(id), v: String(name).slice(0, 255) });
  return { ok: true };
}
// Deletes a board; monday.com keeps it in its trash for 30 days, where it can be restored.
async function deleteBoard(id) {
  const token = readToken();
  if (!token) throw new Error('monday.com is not connected');
  await gql(token, 'mutation ($id: ID!) { delete_board(board_id: $id) { id } }', { id: String(id) });
  return { ok: true };
}

// A board's groups and columns, so an item can be filled in before it is added.
async function boardInfo(id) {
  const token = readToken();
  if (!token) throw Object.assign(new Error('monday.com is not connected'), { code: 'token' });
  const d = await gql(token, 'query ($id: [ID!]) { boards(ids: $id) { id name url groups { id title } columns { id title type } } }', { id: [String(id)] });
  const b = (d.boards || [])[0];
  if (!b) throw new Error('That board is no longer there');
  return { id: b.id, name: b.name, url: b.url, groups: b.groups || [], columns: (b.columns || []).filter(c => c.type !== 'name') };
}
// Add one item. values: { column id: what you typed }. Each is put in the form that kind of column expects; kinds the
// app cannot fill safely (people, files, formulas and the like) are left alone.
const ymd = v => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(v).trim()); if (m) return m[0]; const d = new Date(v); if (isNaN(d)) return ''; const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
function columnValue(type, v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return undefined;
  if (type === 'text') return s;
  if (type === 'long_text') return { text: s };
  if (type === 'numbers' || type === 'numeric') { const n = s.replace(/[^0-9.\-]/g, ''); return n && !isNaN(+n) ? n : undefined; }
  if (type === 'email') return { email: s, text: s };
  if (type === 'phone') return { phone: s.replace(/[^0-9+]/g, '') };
  if (type === 'link') return { url: /^https?:\/\//i.test(s) ? s : 'https://' + s, text: s };
  if (type === 'date') { const d = ymd(s); return d ? { date: d } : undefined; }
  if (type === 'status' || type === 'color') return { label: s };
  if (type === 'dropdown') return { labels: s.split(/\s*,\s*/).filter(Boolean) };
  return undefined;
}
async function createItem({ board, group, name, values, types }) {
  const token = readToken();
  if (!token) throw Object.assign(new Error('monday.com is not connected'), { code: 'token' });
  const cv = {};
  for (const [id, v] of Object.entries(values || {})) { const x = columnValue((types || {})[id], v); if (x !== undefined) cv[id] = x; }
  const d = await gql(token, 'mutation ($b: ID!, $g: String, $n: String!, $v: JSON) { create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $v, create_labels_if_missing: true) { id name board { id url } } }',
    { b: String(board), g: group ? String(group) : null, n: String(name).slice(0, 250), v: JSON.stringify(cv) });
  const it = d.create_item;
  if (!it) throw new Error('monday.com did not add the item');
  return { id: it.id, name: it.name, url: it.board && it.board.url ? `${it.board.url.replace(/\/+$/, '')}/pulses/${it.id}` : '' };
}

module.exports = { saveToken, readToken, clearToken, hasToken, check, fetchAll, createBoard, renameBoard, deleteBoard, boardInfo, createItem };

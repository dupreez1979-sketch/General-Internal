// Mail search: keeping the index (mailindex-worker.js) in step with your mailboxes.
//
// For each account, and each shared mailbox under it, every folder except Junk is read once from start to finish,
// one page at a time and one request at a time, so the rest of Mail stays quick. After that only what changed is
// asked for (Microsoft's "delta" links), every few minutes. Where it has got to is saved after every page, so
// quitting the app loses nothing: it carries on from there next time.
//
// What is kept, on this Mac only, in the app's data folder: who an email is from and to, its subject, date, and
// the first few thousand characters of its text. Removing an account from the app removes its index.

const { app, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');
const accounts = require('./accounts');

const dir = () => path.join(app.getPath('userData'), 'mailindex');
const stateFile = () => path.join(dir(), 'state.json');
const SELECT = 'subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,hasAttachments,isRead,isDraft,conversationId';
const TEXT_MAX = 3000;

let worker = null, ready = null, seq = 0;
const waiting = new Map();
let state = null;                         // { boxes: { key: { folders: { id: { name, link, done } }, error, at } } }
let boxes = [];                           // [{ acc, box }] : the mailboxes to keep indexed (box '' is the account's own)
let running = false, stopping = false, counts = {}, timer = null;

const keyOf = b => (b.box ? `${b.acc}>${b.box}` : b.acc);
function loadState() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { state = { boxes: {} }; }
  if (!state.boxes) state.boxes = {};
  return state;
}
function saveState() { try { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(state)); } catch (e) { /* try again next page */ } }

function ask(msg) {
  return new Promise(resolve => {
    if (!worker) return resolve({ ok: false, error: 'Search is not running' });
    const id = ++seq;
    waiting.set(id, resolve);
    worker.postMessage(Object.assign({ id }, msg));
  });
}
function start() {
  if (ready) return ready;
  worker = utilityProcess.fork(path.join(__dirname, 'mailindex-worker.js'), [], { serviceName: 'Mail search' });
  worker.on('message', m => { const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m.data); } });
  worker.on('exit', () => { worker = null; ready = null; for (const r of waiting.values()) r({ ok: false, error: 'Search stopped' }); waiting.clear(); });
  ready = ask({ op: 'init', dir: dir() }).then(r => { if (r && r.counts) counts = r.counts; return r; });
  return ready;
}

const clean = t => String(t || '').replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const people = l => (l || []).map(x => x.emailAddress).filter(Boolean).map(e => `${e.name || ''} ${e.address || ''}`.trim()).join(', ');
function toDoc(key, folderId, m) {
  const f = (m.from && m.from.emailAddress) || {};
  const body = m.body && m.body.contentType && String(m.body.contentType).toLowerCase() === 'text' ? clean(m.body.content).slice(0, TEXT_MAX) : '';
  return {
    k: `${key}|${m.id}`, i: m.id, a: key, f: folderId, s: m.subject || '', fn: f.name || '', fa: f.address || '', w: `${f.name || ''} ${f.address || ''}`.trim(),
    t: people((m.toRecipients || []).concat(m.ccRecipients || [])), d: Date.parse(m.receivedDateTime) || 0, p: m.bodyPreview || '', x: body || clean(m.bodyPreview),
    h: m.hasAttachments ? 1 : 0, r: m.isRead ? 1 : 0, dr: m.isDraft ? 1 : 0, c: m.conversationId || '',
  };
}

async function listFolders(b) {
  const who = b.box ? `/users/${encodeURIComponent(b.box)}` : '/me';
  const out = [];
  const junk = await accounts.graph(b.acc, { path: `${who}/mailFolders/junkemail?$select=id` });
  const skip = new Set([junk.ok && junk.data && junk.data.id].filter(Boolean));
  const walk = async (path0, depth) => {
    let p = `${path0}?$top=100&$select=id,displayName,childFolderCount,totalItemCount`;
    for (let page = 0; p && page < 20; page++) {
      const r = await accounts.graph(b.acc, { path: p });
      if (!r.ok) { if (!depth) throw Object.assign(new Error(r.error || 'Could not read the folders'), { needsSignIn: r.needsSignIn }); return; }
      for (const f of r.data.value || []) {
        if (skip.has(f.id) || /^(conversation history|sync issues|rss feeds|rss subscriptions|conflicts|local failures|server failures|outbox)$/i.test(f.displayName || '')) continue;
        out.push({ id: f.id, name: f.displayName || '', total: f.totalItemCount || 0 });
        if (f.childFolderCount && depth < 6) await walk(`${who}/mailFolders/${f.id}/childFolders`, depth + 1);
      }
      p = r.data['@odata.nextLink'] || null;
    }
  };
  await walk(`${who}/mailFolders`, 0);
  return out;
}

async function syncBox(b) {
  const key = keyOf(b), who = b.box ? `/users/${encodeURIComponent(b.box)}` : '/me';
  const S = loadState();
  const st = S.boxes[key] = S.boxes[key] || { folders: {} };
  st.error = '';
  let folders;
  try { folders = await listFolders(b); } catch (e) { st.error = e.needsSignIn ? 'Sign in again' : String(e.message || e); saveState(); return; }
  // Folders that have gone: forget their mail.
  const live = new Set(folders.map(f => f.id));
  for (const id of Object.keys(st.folders)) if (!live.has(id)) delete st.folders[id];
  for (const f of folders) {
    if (stopping) break;
    const fs0 = st.folders[f.id] = Object.assign(st.folders[f.id] || {}, { name: f.name, total: f.total });
    let noBody = !!fs0.noBody;
    let link = fs0.link || `${who}/mailFolders/${f.id}/messages/delta?$select=${SELECT}${noBody ? '' : ',body'}`;
    for (let page = 0; link && page < 4000 && !stopping; page++) {
      const r = await accounts.graph(b.acc, { path: link, prefer: 'outlook.body-content-type="text", odata.maxpagesize=50' });
      if (!r.ok) {
        // Some mailboxes will not give the text this way: carry on with the short preview Microsoft always gives.
        if (!noBody && !fs0.link && (r.status === 400 || r.status === 501)) { noBody = fs0.noBody = true; link = `${who}/mailFolders/${f.id}/messages/delta?$select=${SELECT}`; continue; }
        // A link that has gone stale: start this folder again.
        if (fs0.link && (r.status === 410 || r.status === 400)) { delete fs0.link; fs0.done = false; link = `${who}/mailFolders/${f.id}/messages/delta?$select=${SELECT}${noBody ? '' : ',body'}`; continue; }
        st.error = r.needsSignIn ? 'Sign in again' : r.error || 'Could not read mail'; saveState(); return;
      }
      const add = [], gone = [];
      for (const m of r.data.value || []) { if (m['@removed']) gone.push(`${key}|${m.id}`); else if (m.receivedDateTime || m.subject !== undefined) add.push(toDoc(key, f.id, m)); }
      if (gone.length) await ask({ op: 'remove', acc: key, keys: gone });
      if (add.length) await ask({ op: 'add', acc: key, docs: add });
      counts[key] = Math.max(0, (counts[key] || 0) + add.length - gone.length);
      const next = r.data['@odata.nextLink'], delta = r.data['@odata.deltaLink'];
      fs0.link = next || delta || fs0.link;
      if (delta) fs0.done = true;
      saveState();
      link = next || null;
    }
  }
  st.at = Date.now();
  saveState();
}

async function syncAll() {
  if (running || !boxes.length) return;
  running = true; stopping = false;
  try {
    await start();
    const live = new Set(accounts.list().filter(a => !a.needsSignIn).map(a => a.id));
    for (const b of boxes) { if (stopping) break; if (live.has(b.acc)) await syncBox(b); }
    const c = await ask({ op: 'counts' }); if (c && c.counts) counts = c.counts;
  } catch (e) { /* offline: the next round tries again */ }
  running = false;
}

// The window says which mailboxes exist (accounts, and the shared mailboxes you added under them).
function setBoxes(list) {
  const known = new Set(accounts.list().map(a => a.id));
  boxes = (Array.isArray(list) ? list : []).filter(b => b && known.has(String(b.acc))).map(b => ({ acc: String(b.acc), box: /^[^\s\/?#@>|]+@[^\s\/?#@>|]+$/.test(String(b.box || '')) ? String(b.box) : '' }));
  start();
  // Mailboxes no longer here: forget their index.
  const S = loadState(), keep = new Set(boxes.map(keyOf));
  for (const k of Object.keys(S.boxes)) if (!keep.has(k)) { delete S.boxes[k]; ask({ op: 'drop', acc: k }); delete counts[k]; }
  saveState();
  if (!timer) { timer = setInterval(syncAll, 5 * 60e3); setTimeout(syncAll, 8000); }
  return { ok: true };
}
function status() {
  const S = loadState();
  return {
    running,
    boxes: boxes.map(b => {
      const k = keyOf(b), st = S.boxes[k] || { folders: {} }, fl = Object.values(st.folders);
      return { key: k, count: counts[k] || 0, about: fl.reduce((n, f) => n + (f.total || 0), 0), folders: fl.length, done: fl.filter(f => f.done).length, complete: fl.length > 0 && fl.every(f => f.done), error: st.error || '', at: st.at || 0 };
    }),
  };
}
async function search(q, opt) {
  await start();
  const r = await ask({ op: 'search', q: String(q || ''), opt: opt || {} });
  if (r && r.ok) { const S = loadState(); for (const x of r.results) { const st = S.boxes[x._acc]; x._folderName = (st && st.folders[x._folder] && st.folders[x._folder].name) || ''; } }
  return r;
}
// Start a mailbox's index again from nothing.
async function reset(key) {
  stopping = true;
  for (let i = 0; running && i < 100; i++) await new Promise(r => setTimeout(r, 100));
  const S = loadState(); delete S.boxes[key]; saveState();
  await ask({ op: 'drop', acc: key }); delete counts[key];
  setTimeout(syncAll, 500);
  return { ok: true };
}
function stop() { stopping = true; try { if (worker) worker.kill(); } catch (e) { /* gone */ } }

module.exports = { setBoxes, status, search, reset, syncNow: () => { syncAll(); return { ok: true }; }, stop };

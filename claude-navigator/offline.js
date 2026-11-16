// Working offline.
//
// Three things are kept on this Mac only, in the app's data folder:
// 1. Mail and calendar the app has read, so they can be shown again with no internet (the "cache").
// 2. Messages written offline (the "Outbox"): drafts, and emails you pressed Send on while offline.
// 3. Changes made offline (delete, archive, move, flag, read), to be made at Microsoft when you are back.
//
// The send rule still holds: an email in the Outbox is sent only if the Send button was really pressed for it. That
// press is checked in main.js (the same check as an ordinary Send) and recorded here as `armed`. Nothing the window
// says can set it, and editing a waiting email clears it.
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const accounts = require('./accounts');
const maillog = require('./maillog');

const root = () => path.join(app.getPath('userData'), 'offline');
const sub = n => { const d = path.join(root(), n); fs.mkdirSync(d, { recursive: true }); return d; };
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const fileOf = (kind, key) => { const h = sha(key); const d = path.join(sub(kind), h.slice(0, 2)); fs.mkdirSync(d, { recursive: true }); return path.join(d, h + '.json'); };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const writeJson = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v), { mode: 0o600 }); fs.renameSync(t, f); };

// ---------- 1. What has been read ----------
function get(key) { const v = readJson(fileOf('c', key)); return v ? v.d : null; }
function put(key, data) { try { writeJson(fileOf('c', key), { k: String(key).slice(0, 400), at: Date.now(), d: data }); } catch (e) { /* a full disk loses nothing but the copy */ } return true; }
function has(keys) { return (keys || []).map(k => fs.existsSync(fileOf('c', k))); }
function listGet(name) { const v = readJson(fileOf('l', name)); return v ? v.d : null; }
function listPut(name, list) { try { writeJson(fileOf('l', name), { at: Date.now(), d: list }); } catch (e) { /* as above */ } return true; }
// Newer messages seen while online join the front of a kept list, so it is not a day behind when you leave.
function listMerge(name, fresh) {
  const cur = listGet(name); if (!cur || !Array.isArray(fresh) || !fresh.length) return false;
  const ids = new Set(fresh.map(m => m.id));
  const out = fresh.concat(cur.filter(m => !ids.has(m.id))).sort((a, b) => String(b.receivedDateTime).localeCompare(String(a.receivedDateTime))).slice(0, 1500);
  return listPut(name, out);
}
// Attachments kept for offline: one folder per attachment.
const attDir = (acc, msg, att) => path.join(sub('a'), sha(`${acc}|${msg}|${att}`));
async function attKeep(acc, msg, att, name, box) {
  const d = attDir(acc, msg, att);
  try { if (fs.existsSync(d) && fs.readdirSync(d).length) return { ok: true, had: true }; fs.mkdirSync(d, { recursive: true }); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  const r = await accounts.saveAttachment(acc, msg, att, name, box, d);
  if (!r.ok) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* nothing there */ } }
  return r;
}
function copyOut(from, name) {
  const dl = app.getPath('downloads'), clean = (path.basename(String(name || 'attachment')).replace(/[\/\\:\0]/g, '_').replace(/^\.+/, '') || 'attachment').slice(0, 180);
  const ext = path.extname(clean), stem = clean.slice(0, clean.length - ext.length);
  let to = path.join(dl, clean);
  for (let i = 2; fs.existsSync(to) && i < 500; i++) to = path.join(dl, `${stem} ${i}${ext}`);
  fs.copyFileSync(from, to);
  if (/\.(pdf|docx?|xlsx?|pptx?|csv|txt|rtf|png|jpe?g|gif|heic|webp|ics|pages|numbers|key|md)$/i.test(to)) shell.openPath(to); else shell.showItemInFolder(to);
  return { ok: true, path: to, name: path.basename(to) };
}
function attOpen(acc, msg, att, name) {
  try { const d = attDir(acc, msg, att), f = fs.existsSync(d) ? fs.readdirSync(d)[0] : null; if (!f) return { ok: false, error: 'This file was not kept on your Mac. It will open when you are back online.' }; return copyOut(path.join(d, f), name || f); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}
// How much is kept, and clearing out what is old (45 days) so it does not grow for ever.
function walk(dir, fn) { let n = []; try { n = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; } for (const x of n) { const p = path.join(dir, x.name); if (x.isDirectory()) walk(p, fn); else fn(p); } }
function size() { let bytes = 0, files = 0; walk(root(), p => { try { bytes += fs.statSync(p).size; files++; } catch (e) { /* gone */ } }); return { bytes, files }; }
function tidy() { const old = Date.now() - 45 * 864e5; for (const k of ['c', 'a']) walk(path.join(root(), k), p => { try { if (fs.statSync(p).mtimeMs < old) fs.unlinkSync(p); } catch (e) { /* in use */ } }); }
function clear() { for (const k of ['c', 'l', 'a']) { try { fs.rmSync(path.join(root(), k), { recursive: true, force: true }); } catch (e) { /* nothing there */ } } return true; }

// ---------- 2 and 3. The Outbox, and changes waiting to be made ----------
const boxFile = () => path.join(sub('outbox'), 'outbox.json');
let box = null;
function load() {
  if (box) return box;
  box = readJson(boxFile()) || { items: [], ops: [] };
  box.items = Array.isArray(box.items) ? box.items : []; box.ops = Array.isArray(box.ops) ? box.ops : [];
  // An email that was mid-send when the app stopped may or may not have gone. It is never sent a second time by itself.
  for (const it of box.items) if (it.status === 'sending') { it.status = 'failed'; it.armed = false; it.error = 'The app closed while this was being sent. Check Sent Items before sending it again.'; }
  return box;
}
const save = () => writeJson(boxFile(), box);
const view = () => { const b = load(); return { items: b.items.map(it => Object.assign({}, it, { files: (it.files || []).map(f => ({ id: f.id, name: f.name, size: f.size, isInline: !!f.isInline, contentType: f.contentType || '', contentId: f.contentId || '' })) })), ops: b.ops }; };
const find = id => load().items.find(x => x.id === String(id));
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const people = l => (Array.isArray(l) ? l : []).filter(z => z && z.emailAddress && /^[^\s@<>]+@[^\s@<>]+$/.test(String(z.emailAddress.address || ''))).slice(0, 200).map(z => ({ emailAddress: { address: str(z.emailAddress.address, 320), name: str(z.emailAddress.name, 200) } }));
const fileDir = id => path.join(sub('outbox'), sha(id));

// The window saves what is being written. It can never mark an email as waiting to send: only `queue` does, after the click check.
function itemSave(raw) {
  const b = load(); if (!raw || !/^local-[\w-]{4,80}$/.test(String(raw.id))) return { ok: false, error: 'Not a message written here' };
  let it = find(raw.id);
  if (it && (it.status === 'queued' || it.status === 'sending')) return { ok: false, error: 'This email is waiting to be sent. Open it from the Outbox to change it.' };
  if (!it) { it = { id: String(raw.id), files: [], status: 'draft', armed: false, at: Date.now() }; b.items.push(it); }
  Object.assign(it, { acc: str(raw.acc, 400), kind: ['new', 'reply', 'replyAll', 'forward'].includes(raw.kind) ? raw.kind : (it.kind || 'new'), origId: str(raw.origId !== undefined ? raw.origId : it.origId, 600), serverId: str(raw.serverId !== undefined ? raw.serverId : it.serverId, 600),
    subject: str(raw.subject, 1000), body: str(raw.body, 6e6), to: people(raw.to), cc: people(raw.cc), bcc: people(raw.bcc), conv: str(raw.conv !== undefined ? raw.conv : it.conv, 600), status: 'draft', armed: false, error: '', at: Date.now() });
  save(); return { ok: true, box: view() };
}
function itemRemove(id) { const b = load(); b.items = b.items.filter(x => x.id !== String(id)); try { fs.rmSync(fileDir(String(id)), { recursive: true, force: true }); } catch (e) { /* no files */ } save(); return { ok: true, box: view() }; }
function fileAdd(id, f) {
  const it = find(id); if (!it || it.status === 'queued' || it.status === 'sending') return { ok: false, error: 'Open the email from the Outbox to change it' };
  const bytes = Buffer.from(String((f && f.contentBytes) || ''), 'base64'); if (!bytes.length) return { ok: false, error: 'The file was empty' };
  if (bytes.length > 25e6) return { ok: false, error: 'That file is over 25 MB' };
  const rec = { id: 'f' + crypto.randomBytes(6).toString('hex'), name: str(path.basename(String(f.name || 'file')), 200), contentType: str(f.contentType || 'application/octet-stream', 120), size: bytes.length, isInline: !!f.isInline, contentId: str(f.contentId, 200) };
  const d = fileDir(it.id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, rec.id), bytes, { mode: 0o600 });
  it.files = (it.files || []).concat(rec); it.armed = false; save();
  return { ok: true, data: { id: rec.id, name: rec.name, size: rec.size } };
}
function fileRemove(id, fid) { const it = find(id); if (!it || it.status === 'queued' || it.status === 'sending') return { ok: false, error: 'Open the email from the Outbox to change it' }; it.files = (it.files || []).filter(f => f.id !== String(fid)); try { fs.unlinkSync(path.join(fileDir(it.id), path.basename(String(fid)))); } catch (e) { /* gone */ } save(); return { ok: true }; }
function fileBytes(id, fid) { try { return fs.readFileSync(path.join(fileDir(String(id)), path.basename(String(fid)))).toString('base64'); } catch (e) { return ''; } }
function fileOpen(id, fid) { const it = find(id), f = it && (it.files || []).find(x => x.id === String(fid)); if (!f) return { ok: false, error: 'That file is no longer on the message' }; try { return copyOut(path.join(fileDir(it.id), f.id), f.name); } catch (e) { return { ok: false, error: String(e.message || e) }; } }
// Called by main.js only after it has seen a real press of Send.
function queue(id) { const it = find(id); if (!it) return { ok: false, error: 'That message is no longer here' }; if (!it.to.length && !it.cc.length && !it.bcc.length) return { ok: false, error: 'Add someone to send it to' }; it.status = 'queued'; it.armed = true; it.error = ''; it.queuedAt = Date.now(); save(); return { ok: true, box: view() }; }
function unqueue(id) { const it = find(id); if (!it || it.status === 'sending') return { ok: false, error: 'It is being sent' }; it.status = 'draft'; it.armed = false; it.error = ''; save(); return { ok: true, box: view() }; }
function opAdd(op) {
  const b = load(); if (!op || !['move', 'patch', 'delete'].includes(op.kind)) return { ok: false, error: 'Not a change that can wait' };
  const method = String(op.method || '').toUpperCase(), p = String(op.path || '');
  if (!['POST', 'PATCH', 'DELETE'].includes(method) || !/^\/me\/messages\/[^\/?#]+(\/move)?$/.test(p)) return { ok: false, error: 'Not a change that can wait' };
  b.ops.push({ id: 'o' + crypto.randomBytes(5).toString('hex'), acc: str(op.acc, 400), kind: op.kind, msg: str(op.msg, 600), method, path: p, body: op.body && typeof op.body === 'object' ? op.body : undefined, at: Date.now() });
  save(); return { ok: true, box: view() };
}

// Back online: make the waiting changes, turn drafts into drafts in Outlook, and send what Send was pressed on.
const call = (acc, req) => { const [own, bx] = String(acc).split('>'); const r = Object.assign({}, req); if (bx && /^\/me\//.test(r.path)) r.path = '/users/' + encodeURIComponent(bx) + r.path.slice(3); return accounts.graph(own, r); };
const gone = r => r && (r.status === 404 || /ErrorItemNotFound|not found/i.test(String(r.error || '')));
const netDown = r => r && !r.ok && r.status === 0;
async function putFiles(it, sid) {
  for (const f of it.files || []) {
    if (f.sentAs === sid) continue;
    const b64 = fileBytes(it.id, f.id); if (!b64) return { ok: false, error: `“${f.name}” could not be read from this Mac` };
    let r;
    if (f.size <= 3e6) r = await call(it.acc, { method: 'POST', path: `/me/messages/${sid}/attachments`, timeout: 90, body: Object.assign({ '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentType: f.contentType || 'application/octet-stream', contentBytes: b64, isInline: !!f.isInline }, f.contentId ? { contentId: f.contentId } : {}) });
    else {
      r = await call(it.acc, { method: 'POST', path: `/me/messages/${sid}/attachments/createUploadSession`, body: { AttachmentItem: { attachmentType: 'file', name: f.name, size: f.size, contentType: f.contentType || 'application/octet-stream' } } });
      const url = r.ok && r.data && r.data.uploadUrl, bytes = Buffer.from(b64, 'base64'), STEP = 3276800;
      for (let at = 0; url && at < bytes.length && r.ok; at += STEP) r = await accounts.uploadPiece(url, bytes.subarray(at, Math.min(bytes.length, at + STEP)), at, bytes.length);
    }
    if (!r || !r.ok) return { ok: false, net: netDown(r), error: `“${f.name}” could not be attached: ${(r && r.error) || 'try again'}` };
    f.sentAs = sid; save();
  }
  return { ok: true };
}
async function place(it) {            // the message as a draft in Outlook; returns its id there
  if (it.serverId) { const chk = await call(it.acc, { path: `/me/messages/${it.serverId}?$select=id` }); if (chk.ok) return { ok: true, id: it.serverId }; if (!gone(chk)) return chk; it.serverId = ''; for (const f of it.files || []) delete f.sentAs; }
  let r = null;
  if (it.origId && it.kind !== 'new') { r = await call(it.acc, { method: 'POST', path: `/me/messages/${it.origId}/${it.kind === 'reply' ? 'createReply' : it.kind === 'replyAll' ? 'createReplyAll' : 'createForward'}` }); if (!r.ok && !gone(r)) return r; }
  if (!r || !r.ok) r = await call(it.acc, { method: 'POST', path: '/me/messages', body: { subject: it.subject || '', body: { contentType: 'html', content: '' } } });      // (the email replied to has gone: it goes as a message of its own)
  if (!r.ok || !r.data || !r.data.id) return r.ok ? { ok: false, error: 'Outlook did not make the draft' } : r;
  it.serverId = r.data.id; save();
  return { ok: true, id: it.serverId };
}
let flushing = false;
async function flush(skip) {
  if (flushing) return { ok: false, busy: true, box: view() };
  flushing = true;
  const b = load(), rep = { ok: true, sent: 0, drafts: 0, changes: 0, failed: [], stopped: false };
  try {
    // changes first, in the order they were made
    while (b.ops.length) {
      const op = b.ops[0], r = await call(op.acc, { method: op.method, path: op.path, body: op.body });
      if (netDown(r)) { rep.stopped = true; break; }
      b.ops.shift(); save();
      if (r.ok || gone(r)) rep.changes++; else rep.failed.push({ what: 'A change to an email', error: r.error || 'It could not be made' });
    }
    for (const it of rep.stopped ? [] : b.items.slice()) {
      if ((skip || []).includes(it.id) || it.status === 'failed' || it.status === 'sending') continue;
      const sending = it.status === 'queued' && it.armed === true;
      if (it.status === 'queued' && !sending) { it.status = 'draft'; save(); }
      const fail = (r, msg) => { if (netDown(r) || (r && r.net)) { rep.stopped = true; return true; } it.status = 'failed'; it.armed = false; it.error = msg || (r && r.error) || 'It could not be sent'; save(); rep.failed.push({ what: it.subject || '(No subject)', error: it.error }); return false; };
      const p = await place(it);
      if (!p.ok) { if (fail(p)) break; continue; }
      const up = await call(it.acc, { method: 'PATCH', path: `/me/messages/${p.id}`, timeout: 60, body: { subject: it.subject || '', body: { contentType: 'html', content: it.body || '' }, toRecipients: it.to, ccRecipients: it.cc, bccRecipients: it.bcc } });
      if (!up.ok) { if (fail(up)) break; continue; }
      const fl = await putFiles(it, p.id);
      if (!fl.ok) { if (fail(fl, fl.error)) break; continue; }
      if (!sending) { itemRemove(it.id); rep.drafts++; continue; }
      // Sent once: marked first, so a crash at this moment can never lead to a second copy going by itself.
      it.status = 'sending'; save();
      const [own, bx] = String(it.acc).split('>');
      const sn = await accounts.send(own, p.id, bx || '');
      maillog.add({ kind: 'outbox', acc: own, ok: !!sn.ok, error: sn.ok ? '' : sn.error });
      if (sn.ok) { itemRemove(it.id); rep.sent++; continue; }
      if (netDown(sn)) { it.status = 'failed'; it.armed = false; it.error = 'The connection dropped while this was being sent. Check Sent Items before sending it again.'; save(); rep.failed.push({ what: it.subject || '(No subject)', error: it.error }); rep.stopped = true; break; }
      fail(sn);
    }
  } catch (e) { rep.ok = false; rep.error = String(e && e.message || e); }
  flushing = false;
  return Object.assign(rep, { box: view() });
}

module.exports = { get, put, has, listGet, listPut, listMerge, attKeep, attOpen, size, tidy, clear, view, itemSave, itemRemove, fileAdd, fileRemove, fileBytes, fileOpen, queue, unqueue, opAdd, flush };

// Mail and calendar accounts (Microsoft 365, Outlook.com, Hotmail), signed in with Microsoft's own sign-in page in
// your web browser. The app never sees your password. What it keeps is a renewal token, encrypted with your Mac's
// Keychain (Electron safeStorage) in the app's own data folder, so you stay signed in across restarts and updates.
// Tokens never leave this (main) process: the window asks for mail by account id, and the request is made here.

const { app, safeStorage, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const maillog = require('./maillog');

// The app's registration with Microsoft (an identifier, not a secret; there is no client secret).
const MS_CLIENT_ID = 'dab5446b-4bd7-4764-8d0e-4a5cdc747487';
const MS_SCOPES = 'offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite MailboxSettings.Read People.Read';
// Rules, automatic replies and shared mailboxes need more. They are asked for only when you turn those on, with a
// second sign-in, so an account that cannot be given them (an organisation may need its administrator to agree)
// still works for everything else.
const MS_SCOPES_MORE = 'offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite MailboxSettings.ReadWrite People.Read Mail.ReadWrite.Shared Mail.Send.Shared Calendars.ReadWrite.Shared';
const scopesOf = acc => (acc && acc.more ? MS_SCOPES_MORE : MS_SCOPES);
// (When run from source for testing, the two addresses can be pointed at a stand-in server.)
const TEST = !app.isPackaged && process.env.NAV_TEST_MS ? process.env.NAV_TEST_MS.replace(/\/+$/, '') : '';
const MS_AUTH = TEST ? TEST + '/auth' : 'https://login.microsoftonline.com/common/oauth2/v2.0';
const MS_GRAPH = TEST ? TEST + '/graph' : 'https://graph.microsoft.com/v1.0';

const file = () => path.join(app.getPath('userData'), 'accounts.json');
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let cache = null;
const access = new Map();                 // account id -> { token, until }
const renewing = new Map();               // account id -> the renewal in flight

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (e) { cache = []; }
  if (!Array.isArray(cache)) cache = [];
  return cache;
}
function save() { fs.writeFileSync(file(), JSON.stringify(cache, null, 2), { mode: 0o600 }); }
const seal = text => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('This Mac cannot store the sign-in securely right now');
  return safeStorage.encryptString(text).toString('base64');
};
const unseal = b64 => { try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch (e) { return null; } };
const view = a => ({ id: a.id, provider: a.provider, email: a.email, name: a.name, needsSignIn: !!a.needsSignIn, more: !!a.more });

function list() { return load().map(view); }

async function tokenRequest(params) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 25000);
  const res = await net.fetch(MS_AUTH + '/token', { signal: ctl.signal,
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ client_id: MS_CLIENT_ID }, params)).toString(),
  });
  const data = await res.json().catch(() => ({}));
  clearTimeout(tm);
  if (!res.ok || !data.access_token) throw Object.assign(new Error(data.error_description || data.error || `Microsoft answered ${res.status}`), { code: data.error });
  return data;
}

// Sign in: Microsoft's page opens in your web browser; when you finish, it hands a one-time code back to the app
// on this Mac only (http://localhost), which the app exchanges for the tokens.
let signingIn = null;
function add(hintEmail, more) {
  if (signingIn) return signingIn;
  signingIn = (async () => {
    const scope = more ? MS_SCOPES_MORE : MS_SCOPES;
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const server = http.createServer();
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    const redirect = `http://localhost:${server.address().port}`;
    const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>Claude Navigator</title><body style="font:16px -apple-system,sans-serif;display:grid;place-items:center;height:90vh;text-align:center;color:#222"><div><h2>${title}</h2><p>${text}</p></div></body>`;
    try {
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Signing in took too long. Try again.')), 5 * 60e3);
        server.on('request', (req, res) => {
          const u = new URL(req.url, redirect);
          if (!u.searchParams.has('code') && !u.searchParams.has('error')) { res.writeHead(404); return res.end(); }
          const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(ok ? page('You are signed in', 'You can close this tab and go back to Claude Navigator.') : page('Signing in did not finish', 'Go back to Claude Navigator and try again.'));
          clearTimeout(timer);
          if (ok) resolve(ok); else reject(new Error(u.searchParams.get('error_description') || u.searchParams.get('error') || 'Signing in was cancelled'));
        });
        const q = new URLSearchParams({ client_id: MS_CLIENT_ID, response_type: 'code', redirect_uri: redirect, response_mode: 'query', scope, state,
          code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
        if (hintEmail) q.set('login_hint', hintEmail);
        shell.openExternal(`${MS_AUTH}/authorize?${q}`);
      });
      const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, scope });
      if (!t.refresh_token) throw new Error('Microsoft did not allow the app to stay signed in');
      const meRes = await net.fetch(MS_GRAPH + '/me?$select=id,displayName,mail,userPrincipalName', { headers: { Authorization: 'Bearer ' + t.access_token } });
      const me = await meRes.json().catch(() => ({}));
      if (!meRes.ok || !me.id) throw new Error((me.error && me.error.message) || 'Could not read the account');
      const id = 'ms:' + me.id;
      const acc = { id, provider: 'microsoft', email: (me.mail || me.userPrincipalName || '').toLowerCase(), name: me.displayName || '', refresh: seal(t.refresh_token) };
      if (more) acc.more = true;
      load();
      const i = cache.findIndex(a => a.id === id);
      if (i >= 0) cache[i] = acc; else cache.push(acc);
      save();
      access.set(id, { token: t.access_token, until: Date.now() + (t.expires_in - 120) * 1000 });
      return { ok: true, account: view(acc), again: i >= 0 };
    } catch (e) {
      return { ok: false, status: String(e && e.message || e) };
    } finally {
      server.close();
      signingIn = null;
    }
  })();
  return signingIn;
}

function remove(id) {
  load();
  cache = cache.filter(a => a.id !== id);
  save();
  access.delete(id);
  return { ok: true };
}

async function tokenFor(id) {
  const have = access.get(id);
  if (have && have.until > Date.now()) return have.token;
  if (renewing.has(id)) return renewing.get(id);
  const run = (async () => {
    const acc = load().find(a => a.id === id);
    if (!acc) throw new Error('That account is no longer signed in here');
    const refresh = unseal(acc.refresh);
    if (!refresh) { acc.needsSignIn = true; save(); throw Object.assign(new Error('Sign in again'), { needsSignIn: true }); }
    try {
      const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, scope: scopesOf(acc) });
      if (t.refresh_token && t.refresh_token !== refresh) acc.refresh = seal(t.refresh_token);   // Microsoft renews it as it is used
      if (acc.needsSignIn) delete acc.needsSignIn;
      save();
      access.set(id, { token: t.access_token, until: Date.now() + (t.expires_in - 120) * 1000 });
      return t.access_token;
    } catch (e) {
      // Only a refusal from Microsoft means signing in again (not being offline).
      if (e.code === 'invalid_grant' || e.code === 'interaction_required') { acc.needsSignIn = true; save(); throw Object.assign(new Error('Sign in again'), { needsSignIn: true }); }
      throw e;
    }
  })().finally(() => renewing.delete(id));
  renewing.set(id, run);
  return run;
}

// Microsoft allows an app only four requests at a time per mailbox ("MailboxConcurrency"). Requests for an account
// therefore queue here, three at a time, and one that is told to slow down waits as asked and tries again.
// Microsoft allows an app only four requests at a time per mailbox ("MailboxConcurrency"), and slows an app down
// ("throttling") that asks for too much. So, for each account:
//   - what you are doing in the window goes first, three at a time;
//   - background reading (the search index) goes one at a time, and only while nothing of yours is waiting;
//   - every request has a time limit, so one that never answers cannot hold everything else up;
//   - when Microsoft says slow down, background reading stops for as long as it asks, and your own requests wait a
//     few seconds at most before telling you plainly.
// Each request is written to the log (maillog.js).
const lanes = new Map();                  // account id -> { busy, waiting, bgBusy, bgWaiting, slowUntil }
const laneOf = id => { let l = lanes.get(id); if (!l) { l = { busy: 0, waiting: [], bgBusy: 0, bgWaiting: [], slowUntil: 0 }; lanes.set(id, l); } return l; };
function pump(lane) {
  while (lane.busy < 3 && lane.waiting.length) lane.waiting.shift()();
  if (!lane.busy && !lane.waiting.length && !lane.bgBusy && lane.bgWaiting.length) lane.bgWaiting.shift()();
}
function inLane(id, work, bg) {
  const lane = laneOf(id);
  return new Promise((resolve, reject) => {
    const run = () => {
      if (bg) lane.bgBusy++; else lane.busy++;
      work().then(resolve, reject).finally(() => { if (bg) lane.bgBusy--; else lane.busy--; pump(lane); });
    };
    if (bg) lane.bgWaiting.push(run); else lane.waiting.push(run);
    pump(lane);
  });
}
const pause = ms => new Promise(r => setTimeout(r, ms));
const slowUntil = id => laneOf(id).slowUntil || 0;
const queueOf = id => { const l = laneOf(id); return { busy: l.busy, waiting: l.waiting.length, background: l.bgBusy + l.bgWaiting.length, slowUntil: l.slowUntil }; };

// One request to Microsoft Graph for an account. Only Graph paths; the token is added here.
// THE SEND LOCK. Nothing that asks through graph() can send, reply to or forward mail: those requests are refused
// here. An email leaves only through send() below, which main.js lets through only straight after a real click on
// the Send button in the app's own window. Drafting helpers, Claude's pages and anything automatic have no way past.
const SENDS = /\/(send|sendmail|reply|replyall|forward)\/?(\?.*)?$/i;
function graph(id, req) {
  if (req && SENDS.test(String(req.path || '').split('#')[0])) return Promise.resolve({ ok: false, status: 0, error: 'Only the Send button can send an email' });
  return inLane(id, () => graphNow(id, req, false), false);
}
// The same, for background reading: lowest priority, and it gives way at once when Microsoft says slow down.
function graphBg(id, req) {
  if (req && SENDS.test(String(req.path || '').split('#')[0])) return Promise.resolve({ ok: false, status: 0, error: 'Only the Send button can send an email' });
  return inLane(id, () => graphNow(id, req, true), true);
}
function send(id, msgId, box) {
  const who = box && /^[^\s\/?#@]+@[^\s\/?#@]+$/.test(String(box)) ? '/users/' + encodeURIComponent(box) : '/me';
  return inLane(id, () => graphNow(id, { method: 'POST', path: `${who}/messages/${encodeURIComponent(String(msgId))}/send`, timeout: 60 }, false, true), false);
}
// A request with a time limit (seconds). A request that runs out of time is given up on, not left hanging.
async function timed(url, init, seconds) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), seconds * 1000);
  try { return await net.fetch(url, Object.assign({ signal: ctl.signal }, init)); }
  catch (e) { if (ctl.signal.aborted) throw Object.assign(new Error(`Microsoft did not answer within ${seconds} seconds`), { timeout: true }); throw e; }
  finally { clearTimeout(timer); }
}
async function graphNow(id, req, bg, isSend) {
  const r = req || {};
  const method = String(r.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return { ok: false, status: 0, error: 'Not allowed' };
  let url = String(r.path || '');
  if (url.startsWith(MS_GRAPH + '/')) url = url.slice(MS_GRAPH.length);        // a "next page" link from Graph
  if (!url.startsWith('/') || url.includes('://')) return { ok: false, status: 0, error: 'Not a mail request' };
  const lane = laneOf(id), began = Date.now(), limit = Math.max(5, Math.min(120, +r.timeout || (bg ? 45 : 30)));
  let tries = 0;
  const done = out => { maillog.add({ kind: 'req', acc: id, method, path: url, status: out.status, ok: !!out.ok, ms: Date.now() - began, tries, bg: bg ? 1 : 0, send: isSend ? 1 : 0, timeout: out.timeout ? 1 : 0, error: out.ok ? '' : out.error }); return out; };
  try {
    const ask = async token => timed(MS_GRAPH + url, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, r.body !== undefined ? { 'Content-Type': 'application/json' } : {}, r.prefer ? { Prefer: String(r.prefer) } : {}),
      body: r.body !== undefined ? JSON.stringify(r.body) : undefined,
    }, limit);
    // Microsoft asked for a pause a moment ago: background work does not even try; yours waits out a short one.
    const wait0 = lane.slowUntil - Date.now();
    if (wait0 > 0) { if (bg) return done({ ok: false, status: 429, retryAfter: Math.ceil(wait0 / 1000), error: 'Waiting, as Microsoft asked' }); if (wait0 <= 8000) await pause(wait0); }
    let res = await ask(await tokenFor(id));
    if (res.status === 401) { access.delete(id); res = await ask(await tokenFor(id)); }
    // 429 and 503 mean "slow down"; 500, 502 and 504 are faults at Microsoft's end that usually clear in a second or two.
    while ([429, 500, 502, 503, 504].includes(res.status)) {
      const fault = res.status === 500 || res.status === 502 || res.status === 504;
      const ra = Math.max(1, Math.min(900, +res.headers.get('retry-after') || (fault ? 2 * (tries + 1) : 5 * (tries + 1))));
      if (!fault) { lane.slowUntil = Math.max(lane.slowUntil, Date.now() + ra * 1000); maillog.add({ kind: 'slow', acc: id, status: res.status, error: `Microsoft asked the app to wait ${ra} seconds`, bg: bg ? 1 : 0 }); }
      if (bg || tries >= (fault ? 3 : 2) || ra > 8) { try { await res.text(); } catch (e) { /* nothing to read */ }
        return done({ ok: false, status: res.status, retryAfter: ra, error: fault ? `Microsoft had a fault at its end (${res.status}). It usually clears quickly: click Sync to try again.` : `Microsoft is asking the app to slow down. Try again in ${ra < 60 ? `about ${ra} seconds` : `about ${Math.ceil(ra / 60)} minutes`}.` }); }
      tries++;
      await pause(ra * 1000);
      res = await ask(await tokenFor(id));
    }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    return done({ ok: res.ok, status: res.status, data, error: res.ok ? undefined : (data && data.error && data.error.message) || `Microsoft answered ${res.status}` });
  } catch (e) {
    return done({ ok: false, status: 0, timeout: !!e.timeout, needsSignIn: !!e.needsSignIn, error: e.timeout ? e.message : /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION/i.test(String(e && e.message)) ? 'No internet connection, or Microsoft could not be reached' : String(e && e.message || e) });
  }
}

// Save one attachment into Downloads (never over a file already there) and say where it went.
async function saveAttachment(id, msgId, attId, name, box, toDir) {
  try {
    const who = box && /^[^\s\/?#@]+@[^\s\/?#@]+$/.test(String(box)) ? '/users/' + encodeURIComponent(box) : '/me';   // a shared mailbox, or your own
    const send = async token => timed(`${MS_GRAPH}${who}/messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(attId)}/$value`, { headers: { Authorization: 'Bearer ' + token } }, 120);
    let res = await send(await tokenFor(id));
    if (res.status === 401) { access.delete(id); res = await send(await tokenFor(id)); }
    if (!res.ok) return { ok: false, error: `Microsoft answered ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const clean = (path.basename(String(name || 'attachment')).replace(/[\/\\:\0]/g, '_').replace(/^\.+/, '') || 'attachment').slice(0, 180);
    const dir = toDir || app.getPath('downloads'), ext = path.extname(clean), stem = clean.slice(0, clean.length - ext.length);
    let file2 = path.join(dir, clean);
    for (let i = 2; fs.existsSync(file2) && i < 500; i++) file2 = path.join(dir, `${stem} ${i}${ext}`);
    fs.writeFileSync(file2, buf, { flag: 'wx' });
    return { ok: true, path: file2, name: path.basename(file2) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Save a whole email as a file (.eml: it opens in Outlook or Mail with everything in it) and say where it went.
async function saveMime(id, msgId, name, box, toDir) {
  try {
    const who = box && /^[^\s\/?#@]+@[^\s\/?#@]+$/.test(String(box)) ? '/users/' + encodeURIComponent(box) : '/me';
    const send = async token => timed(`${MS_GRAPH}${who}/messages/${encodeURIComponent(msgId)}/$value`, { headers: { Authorization: 'Bearer ' + token } }, 120);
    let res = await send(await tokenFor(id));
    if (res.status === 401) { access.delete(id); res = await send(await tokenFor(id)); }
    if (!res.ok) return { ok: false, error: `Microsoft answered ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const stem = (String(name || 'Email').replace(/[\/\\:*?"<>|\0\r\n]/g, ' ').replace(/\s+/g, ' ').replace(/^\.+/, '').trim() || 'Email').slice(0, 120);
    const dir = toDir || app.getPath('downloads');
    let file2 = path.join(dir, stem + '.eml');
    for (let i = 2; fs.existsSync(file2) && i < 500; i++) file2 = path.join(dir, `${stem} ${i}.eml`);
    fs.writeFileSync(file2, buf, { flag: 'wx' });
    return { ok: true, path: file2, name: path.basename(file2) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// One piece of a large attachment. Microsoft hands out a one-off upload address for the file (it needs no token);
// only Microsoft's own mail servers are accepted here.
async function uploadPiece(url, bytes, start, total) {
  try {
    const u = new URL(String(url));
    const okHost = TEST ? String(url).startsWith(TEST + '/') : u.protocol === 'https:' && /(^|\.)(office\.com|office365\.com|outlook\.com|microsoft\.com)$/i.test(u.hostname);
    if (!okHost) return { ok: false, error: 'Not an upload address from Microsoft' };
    const buf = Buffer.from(bytes);
    if (!buf.length || buf.length > 4 * 1024 * 1024) return { ok: false, error: 'Piece too large' };
    const res = await timed(u.toString(), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${+start}-${+start + buf.length - 1}/${+total}` }, body: buf }, 120);
    if (!res.ok) { const t = await res.text().catch(() => ''); let m = ''; try { m = JSON.parse(t).error.message; } catch (e) { /* plain text */ } return { ok: false, error: m || `Microsoft answered ${res.status}` }; }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

module.exports = { list, add, remove, graph, graphBg, slowUntil, queueOf, send, saveAttachment, saveMime, uploadPiece };

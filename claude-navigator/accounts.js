// Mail and calendar accounts (Microsoft 365, Outlook.com, Hotmail), signed in with Microsoft's own sign-in page in
// your web browser. The app never sees your password. What it keeps is a renewal token, encrypted with your Mac's
// Keychain (Electron safeStorage) in the app's own data folder, so you stay signed in across restarts and updates.
// Tokens never leave this (main) process: the window asks for mail by account id, and the request is made here.

const { app, safeStorage, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

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
  const res = await net.fetch(MS_AUTH + '/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ client_id: MS_CLIENT_ID }, params)).toString(),
  });
  const data = await res.json().catch(() => ({}));
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
const lanes = new Map();                  // account id -> { busy, waiting }
function inLane(id, work) {
  const lane = lanes.get(id) || { busy: 0, waiting: [] };
  lanes.set(id, lane);
  return new Promise((resolve, reject) => {
    const run = () => {
      lane.busy++;
      work().then(resolve, reject).finally(() => { lane.busy--; const next = lane.waiting.shift(); if (next) next(); });
    };
    if (lane.busy < 3) run(); else lane.waiting.push(run);
  });
}
const pause = ms => new Promise(r => setTimeout(r, ms));

// One request to Microsoft Graph for an account. Only Graph paths; the token is added here.
// THE SEND LOCK. Nothing that asks through graph() can send, reply to or forward mail: those requests are refused
// here. An email leaves only through send() below, which main.js lets through only straight after a real click on
// the Send button in the app's own window. Drafting helpers, Claude's pages and anything automatic have no way past.
const SENDS = /\/(send|sendmail|reply|replyall|forward)\/?(\?.*)?$/i;
function graph(id, req) {
  if (req && SENDS.test(String(req.path || '').split('#')[0])) return Promise.resolve({ ok: false, status: 0, error: 'Only the Send button can send an email' });
  return inLane(id, () => graphNow(id, req));
}
function send(id, msgId, box) {
  const who = box && /^[^\s\/?#@]+@[^\s\/?#@]+$/.test(String(box)) ? '/users/' + encodeURIComponent(box) : '/me';
  return inLane(id, () => graphNow(id, { method: 'POST', path: `${who}/messages/${encodeURIComponent(String(msgId))}/send` }));
}
async function graphNow(id, req) {
  const r = req || {};
  const method = String(r.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return { ok: false, status: 0, error: 'Not allowed' };
  let url = String(r.path || '');
  if (url.startsWith(MS_GRAPH + '/')) url = url.slice(MS_GRAPH.length);        // a "next page" link from Graph
  if (!url.startsWith('/') || url.includes('://')) return { ok: false, status: 0, error: 'Not a mail request' };
  try {
    const send = async token => net.fetch(MS_GRAPH + url, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, r.body !== undefined ? { 'Content-Type': 'application/json' } : {}, r.prefer ? { Prefer: String(r.prefer) } : {}),
      body: r.body !== undefined ? JSON.stringify(r.body) : undefined,
    });
    let res = await send(await tokenFor(id));
    if (res.status === 401) { access.delete(id); res = await send(await tokenFor(id)); }
    for (let tries = 0; (res.status === 429 || res.status === 503 || res.status === 504) && tries < 4; tries++) {
      const wait = Math.min(15, Math.max(1, +res.headers.get('retry-after') || 2 * (tries + 1)));
      await pause(wait * 1000);
      res = await send(await tokenFor(id));
    }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : (data && data.error && data.error.message) || `Microsoft answered ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, needsSignIn: !!e.needsSignIn, error: String(e && e.message || e) };
  }
}

// Save one attachment into Downloads (never over a file already there) and say where it went.
async function saveAttachment(id, msgId, attId, name, box) {
  try {
    const who = box && /^[^\s\/?#@]+@[^\s\/?#@]+$/.test(String(box)) ? '/users/' + encodeURIComponent(box) : '/me';   // a shared mailbox, or your own
    const send = async token => net.fetch(`${MS_GRAPH}${who}/messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(attId)}/$value`, { headers: { Authorization: 'Bearer ' + token } });
    let res = await send(await tokenFor(id));
    if (res.status === 401) { access.delete(id); res = await send(await tokenFor(id)); }
    if (!res.ok) return { ok: false, error: `Microsoft answered ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const clean = (path.basename(String(name || 'attachment')).replace(/[\/\\:\0]/g, '_').replace(/^\.+/, '') || 'attachment').slice(0, 180);
    const dir = app.getPath('downloads'), ext = path.extname(clean), stem = clean.slice(0, clean.length - ext.length);
    let file2 = path.join(dir, clean);
    for (let i = 2; fs.existsSync(file2) && i < 500; i++) file2 = path.join(dir, `${stem} ${i}${ext}`);
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
    const res = await net.fetch(u.toString(), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${+start}-${+start + buf.length - 1}/${+total}` }, body: buf });
    if (!res.ok) { const t = await res.text().catch(() => ''); let m = ''; try { m = JSON.parse(t).error.message; } catch (e) { /* plain text */ } return { ok: false, error: m || `Microsoft answered ${res.status}` }; }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

module.exports = { list, add, remove, graph, send, saveAttachment, uploadPiece };

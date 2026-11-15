// Granola: the app signs in to Granola's own connection for AI tools (the same one Claude uses) and reads meeting
// notes through it. You sign in once in your web browser; the sign-in is encrypted with your Mac's Keychain
// (Electron safeStorage) in the app's own data folder. Nothing is written back to Granola: the app only reads.

const { app, safeStorage, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const endpoint = () => (!app.isPackaged && process.env.NAV_TEST_GRANOLA_MCP) || 'https://mcp.granola.ai/mcp';
const file = () => path.join(app.getPath('userData'), 'granola.json');
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const seal = text => { if (!safeStorage.isEncryptionAvailable()) throw new Error('This Mac cannot store the sign-in securely right now'); return safeStorage.encryptString(text).toString('base64'); };
const unseal = b64 => { try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch (e) { return null; } };

let store = null;                       // { client: { id, secret }, token_endpoint, refresh, access, until }
const load = () => { if (store) return store; try { store = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch (e) { store = {}; } return store; };
const save = () => { try { fs.writeFileSync(file(), JSON.stringify(store, null, 2), { mode: 0o600 }); } catch (e) { /* signing in again still works */ } };
let access = null;                      // { token, until } kept in memory
let session = null;                     // { id, version } for the conversation with Granola's server
let rpcId = 0;
let trail = [];                         // what happened, step by step, for working out a failure (never holds a token)
const note = t => { trail.push(`${new Date().toISOString().slice(11, 19)} ${t}`); if (trail.length > 60) trail.shift(); };

class Step extends Error { constructor(step, message) { super(message); this.step = step; } }
const timed = async (url, init, seconds = 25) => {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), seconds * 1000);
  try { return await net.fetch(url, Object.assign({ signal: ctl.signal }, init)); }
  catch (e) { throw new Error(ctl.signal.aborted ? 'no answer in time' : String(e && e.message || e)); }
  finally { clearTimeout(timer); }
};
const getJson = async url => { const r = await timed(url, { headers: { Accept: 'application/json' } }); note(`GET ${new URL(url).host}${new URL(url).pathname} -> ${r.status}`); if (!r.ok) return null; return r.json().catch(() => null); };

// Where to sign in: Granola's server says so itself.
async function discover() {
  const mcp = new URL(endpoint());
  let metaUrl = '';
  try {
    const r = await timed(mcp.href, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Claude Navigator', version: app.getVersion() } } }) });
    note(`first call -> ${r.status}`);
    const m = /resource_metadata="?([^",\s]+)"?/i.exec(r.headers.get('www-authenticate') || '');
    if (m) metaUrl = m[1];
  } catch (e) { note('first call failed: ' + e.message); throw new Step('reaching Granola', e.message); }
  let res = null;
  for (const u of [metaUrl, `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname}`, `${mcp.origin}/.well-known/oauth-protected-resource`].filter(Boolean)) { res = await getJson(u).catch(() => null); if (res) break; }
  const issuer = (res && Array.isArray(res.authorization_servers) && res.authorization_servers[0]) || mcp.origin;
  const iu = new URL(issuer), p = iu.pathname.replace(/\/$/, '');
  let meta = null;
  for (const u of [`${iu.origin}/.well-known/oauth-authorization-server${p}`, `${iu.origin}${p}/.well-known/oauth-authorization-server`, `${iu.origin}/.well-known/openid-configuration${p}`, `${iu.origin}${p}/.well-known/openid-configuration`]) { meta = await getJson(u).catch(() => null); if (meta && meta.authorization_endpoint && meta.token_endpoint) break; meta = null; }
  if (!meta) throw new Step('finding the sign-in', 'Granola did not say where to sign in');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) if (meta[k] && !/^https:\/\//.test(meta[k]) && !(!app.isPackaged && /^http:\/\/127\.0\.0\.1/.test(meta[k]))) throw new Step('finding the sign-in', 'the sign-in address is not a secure one');
  return { meta, scopes: (res && res.scopes_supported) || meta.scopes_supported || [] };
}

async function tokenRequest(params) {
  const s = load(), body = new URLSearchParams(Object.assign({ client_id: s.client.id, resource: endpoint() }, params));
  if (s.client.secret) body.set('client_secret', s.client.secret);
  const r = await timed(s.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() });
  const j = await r.json().catch(() => ({}));
  note(`token (${params.grant_type}) -> ${r.status}${j.error ? ' ' + j.error : ''}`);
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `the sign-in server answered ${r.status}`);
  access = { token: j.access_token, until: Date.now() + ((j.expires_in || 3600) - 120) * 1000 };
  if (j.refresh_token) s.refresh = seal(j.refresh_token);
  s.access = seal(j.access_token); s.until = access.until;          // (kept too, for servers that give no refresh)
  save();
  return access.token;
}

let signingIn = null;
function connect() {
  if (signingIn) return signingIn;
  signingIn = (async () => {
    trail = []; session = null;
    const server = http.createServer();
    try {
      const { meta, scopes } = await discover();
      await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
      const redirect = `http://127.0.0.1:${server.address().port}/callback`;
      if (!meta.registration_endpoint) throw new Step('registering the app', 'Granola does not let a new app register itself');
      const reg = await timed(meta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_name: 'Claude Navigator', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' }) });
      const rj = await reg.json().catch(() => ({}));
      note(`register -> ${reg.status}${rj.error ? ' ' + rj.error : ''}`);
      if (!reg.ok || !rj.client_id) throw new Step('registering the app', rj.error_description || rj.error || `Granola answered ${reg.status}`);
      store = { client: { id: rj.client_id, secret: rj.client_secret || '' }, token_endpoint: meta.token_endpoint }; access = null; save();
      const verifier = b64url(crypto.randomBytes(48)), challenge = b64url(crypto.createHash('sha256').update(verifier).digest()), state = b64url(crypto.randomBytes(16));
      const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>Claude Navigator</title><body style="font:16px -apple-system,sans-serif;display:grid;place-items:center;height:90vh;text-align:center;color:#222"><div><h2>${title}</h2><p>${text}</p></div>`;
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Step('signing in', 'Signing in took too long. Try again.')), 5 * 60e3);
        server.on('request', (req, res) => {
          const u = new URL(req.url, redirect);
          if (!u.searchParams.has('code') && !u.searchParams.has('error')) { res.writeHead(404); return res.end(); }
          const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(ok ? page('Granola is connected', 'You can close this tab and go back to Claude Navigator.') : page('Signing in did not finish', 'Go back to Claude Navigator and try again.'));
          clearTimeout(timer);
          if (ok) resolve(ok); else reject(new Step('signing in', u.searchParams.get('error_description') || u.searchParams.get('error') || 'Signing in was cancelled'));
        });
        const q = new URLSearchParams({ response_type: 'code', client_id: rj.client_id, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256', resource: endpoint() });
        if (scopes.length) q.set('scope', scopes.join(' '));
        note('browser opened for sign-in');
        shell.openExternal(`${meta.authorization_endpoint}${meta.authorization_endpoint.includes('?') ? '&' : '?'}${q}`);
      });
      note('came back from the browser');
      try { await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }); } catch (e) { throw new Step('finishing the sign-in', e.message); }
      return Object.assign({ ok: true }, await test());
    } catch (e) {
      note(`stopped while ${e.step || 'connecting'}: ${e.message}`);
      return { ok: false, step: e.step || 'connecting', status: String(e && e.message || e), details: trail.join('\n') };
    } finally { try { server.close(); } catch (e) { /* never opened */ } signingIn = null; }
  })();
  return signingIn;
}

async function token() {
  const s = load();
  if (!s.client) throw new Step('signing in', 'Granola is not connected yet');
  if (access && Date.now() < access.until) return access.token;
  if (!access && s.access && s.until && Date.now() < s.until) { const t = unseal(s.access); if (t) { access = { token: t, until: s.until }; return t; } }
  const r = s.refresh && unseal(s.refresh);
  if (!r) throw new Step('signing in', 'The Granola sign-in has run out. Connect again.');
  try { return await tokenRequest({ grant_type: 'refresh_token', refresh_token: r }); } catch (e) { throw new Step('signing in', 'The Granola sign-in has run out. Connect again.'); }
}

// One request to Granola's server. Its answers come either as plain JSON or as a short stream of "data:" lines.
async function post(body, again) {
  const t = await token();
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + t };
  if (session) { if (session.id) headers['Mcp-Session-Id'] = session.id; headers['MCP-Protocol-Version'] = session.version; }
  const r = await timed(endpoint(), { method: 'POST', headers, body: JSON.stringify(body) }, 60);
  note(`${body.method} -> ${r.status}`);
  if (r.status === 401 && !again) { access = null; const s = load(); delete s.access; delete s.until; return post(body, true); }
  if (r.status === 404 && session && !again && body.method !== 'initialize') { session = null; await start(); return post(body, true); }
  if (body.id === undefined) return { res: r };
  const text = await r.text();
  if (!r.ok) throw new Error(`Granola answered ${r.status}${text ? ': ' + text.replace(/\s+/g, ' ').slice(0, 160) : ''}`);
  let msg = null;
  if (/event-stream/i.test(r.headers.get('content-type') || '')) { for (const line of text.split(/\r?\n/)) { if (!line.startsWith('data:')) continue; try { const j = JSON.parse(line.slice(5).trim()); if (j && j.id === body.id) msg = j; } catch (e) { /* not this line */ } } }
  else { try { msg = JSON.parse(text); } catch (e) { /* not JSON */ } }
  if (!msg) throw new Error('Granola’s answer could not be read');
  if (msg.error) throw new Error(msg.error.message || 'Granola reported a problem');
  return { res: r, result: msg.result };
}
async function start() {
  if (session) return;
  session = null;
  const { res, result } = await post({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Claude Navigator', version: app.getVersion() } } });
  session = { id: res.headers.get('mcp-session-id') || '', version: (result && result.protocolVersion) || '2025-06-18' };
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
}
async function tools() { await start(); const { result } = await post({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} }); return (result && result.tools) || []; }
// The app only ever reads. Granola's connection can also change things (folders, notes); those are refused here.
const READ_ONLY = new Set(['query_granola_meetings', 'list_meetings', 'list_meeting_folders', 'get_meetings', 'get_meeting_transcript', 'get_account_info', 'search_meetings', 'search_transcripts', 'get_meeting_attachment']);
async function call(name, args) {
  if (!READ_ONLY.has(name)) throw new Error('The app only reads from Granola');
  await start();
  const { result } = await post({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args || {} } });
  const text = ((result && result.content) || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (result && result.isError) throw new Error(text.replace(/\s+/g, ' ').slice(0, 200) || 'Granola could not do that');
  return text;
}

// The proof it works: what Granola offers, and how many meetings from the last seven days it can see.
// Only names and a count leave this function: no meeting content.
async function test() {
  try {
    const list = await tools(), names = list.map(t => t.name);
    note(`tools: ${names.join(', ')}`);
    const find = list.find(t => /^(search_meetings|list_meetings)$/.test(t.name)) || list.find(t => /meeting/i.test(t.name) && /list|search/i.test(t.name));
    let meetings = null, how = '';
    if (find) {
      const props = (find.inputSchema && find.inputSchema.properties) || {}, day = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10), args = {};
      if (props.from_date) args.from_date = day(7); if (props.to_date) args.to_date = day(-1); if (props.limit) args.limit = 100;
      if (props.time_range && !props.from_date) args.time_range = 'last_week';
      const text = await call(find.name, args);
      const ids = new Set((text.match(/<meeting\b[^>]*\bid="[^"]+"/g) || []).concat(text.match(/"id"\s*:\s*"[^"]+"/g) || []));
      meetings = ids.size; how = find.name;
      note(`${find.name} -> ${text.length} characters, ${meetings} meetings counted`);
    }
    return { connected: true, tools: names, meetings, how, details: trail.join('\n') };
  } catch (e) {
    note(`stopped while ${e.step || 'reading meetings'}: ${e.message}`);
    return { connected: !!load().client, failed: true, step: e.step || 'reading meetings', status: String(e && e.message || e), details: trail.join('\n') };
  }
}

// Every meeting between two days (the list comes a page at a time).
async function meetings(from, to) {
  let text = '', cursor = '';
  for (let page = 0; page < 5; page++) {
    const part = await call('search_meetings', cursor ? { cursor } : { from_date: from, to_date: to, limit: 100, max_participants: 8 });
    text += part + '\n';
    const m = /<pagination\b[^>]*\bnext_cursor="([^"]+)"/.exec(part);
    if (!m || !/has_more="true"/.test(part)) break;
    cursor = m[1];
  }
  return text;
}

function status() { const s = load(); return { connected: !!(s.client && (s.refresh || s.access)) }; }
function disconnect() { store = {}; access = null; session = null; try { fs.rmSync(file(), { force: true }); } catch (e) { /* already gone */ } return { connected: false }; }

module.exports = { connect, disconnect, status, test, call, tools, meetings };

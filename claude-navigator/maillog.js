// A plain record of every request the app makes to Microsoft for mail and calendar: when, which account, what kind,
// how long it took, and how it ended. It is for working out what went wrong when mail is slow or stuck.
// It never holds a password, a token, or the content of an email: only addresses of requests with the long ids cut
// short. Kept in the app's own data folder (logs/mail.log, two files of about 2 MB at most).

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const dir = () => path.join(app.getPath('userData'), 'logs');
const file = () => path.join(dir(), 'mail.log');
const recent = [];                        // the last few hundred, in memory, for the health screen
let ready = false;

// What a request was, without what it carried: ids shortened, searches and filters dropped.
function shape(p) {
  return String(p || '').replace(/^https?:\/\/[^/]+(\/v1\.0|\/graph)?/i, '').split('?')[0]
    .replace(/\/users\/[^/]+/i, '/users/(shared)').replace(/[A-Za-z0-9_=-]{30,}/g, m => m.slice(0, 6) + '…').slice(0, 120);
}
function add(e) {
  const row = Object.assign({ t: Date.now() }, e);
  if (row.path !== undefined) row.path = shape(row.path);
  if (row.error) row.error = String(row.error).slice(0, 200);
  recent.push(row); if (recent.length > 600) recent.splice(0, recent.length - 600);
  try {
    if (!ready) { fs.mkdirSync(dir(), { recursive: true }); ready = true; }
    const f = file();
    try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + '.1'); } catch (err) { /* no file yet */ }
    fs.appendFileSync(f, JSON.stringify(Object.assign({}, row, { t: new Date(row.t).toISOString() })) + '\n');
  } catch (err) { /* logging must never break mail */ }
}
// A summary per account over the last ten minutes, and the latest problems.
function health(names = {}) {
  const now = Date.now(), since = now - 10 * 60e3, by = {};
  for (const r of recent) {
    if (!r.acc) continue;
    const a = by[r.acc] = by[r.acc] || { acc: r.acc, email: names[r.acc] || '', lastOk: 0, lastErr: '', lastErrAt: 0, n: 0, errs: 0, slow: 0, ms: 0, bg: 0, timeouts: 0 };
    if (r.kind !== 'req') continue;
    if (r.ok) a.lastOk = Math.max(a.lastOk, r.t); else { a.lastErr = `${r.status || ''} ${r.error || ''}`.trim(); a.lastErrAt = r.t; }
    if (r.t < since) continue;
    a.n++; a.ms += r.ms || 0; if (r.bg) a.bg++;
    if (!r.ok) a.errs++;
    if (r.status === 429 || r.status === 503) a.slow++;
    if (r.timeout) a.timeouts++;
  }
  for (const a of Object.values(by)) a.avg = a.n ? Math.round(a.ms / a.n) : 0;
  return { accounts: Object.values(by), problems: recent.filter(r => r.kind !== 'req' || !r.ok).slice(-40).reverse(), file: file() };
}
module.exports = { add, health, file };

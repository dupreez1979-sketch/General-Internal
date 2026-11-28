// The search index for Mail. It runs in a process of its own, so reading a large mailbox into it, or a big search,
// never makes the app's window stutter. It keeps one line of text per email in a file per account (in the app's own
// data folder on this Mac), loads those into memory when the app starts, and answers searches from there.
//
// It talks only to the app's main process: add these emails, forget those, search for this.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const MiniSearch = require('./vendor/minisearch.cjs');

let dir = '';
let loaded = false;
const docs = new Map();                    // key (account|message id) -> the email's line
const files = new Map();                   // account -> { lines, live } for tidying its file
const newIndex = () => new MiniSearch({ idField: 'k', fields: ['s', 'w', 't', 'x'], storeFields: [] });
let index = newIndex();

const fileOf = acc => path.join(dir, encodeURIComponent(acc) + '.jsonl');
const tick = () => new Promise(r => setImmediate(r));

async function loadAll() {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
    const acc = decodeURIComponent(name.slice(0, -6));
    const stat = { lines: 0, live: 0 };
    files.set(acc, stat);
    const mine = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, name), 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      stat.lines++;
      try { const o = JSON.parse(line); if (o['-']) mine.delete(o['-']); else if (o.k) mine.set(o.k, o); } catch (e) { /* a torn last line */ }
    }
    stat.live = mine.size;
    let batch = [];
    for (const d of mine.values()) {
      docs.set(d.k, d); batch.push(d);
      if (batch.length >= 400) { index.addAll(batch); batch = []; await tick(); }
    }
    if (batch.length) index.addAll(batch);
    // Tidy a file that has become mostly history (changes and removals).
    if (stat.lines > 2000 && stat.live < stat.lines * 0.6) rewrite(acc);
  }
  loaded = true;
}
function rewrite(acc) {
  const tmp = fileOf(acc) + '.tmp';
  const out = fs.openSync(tmp, 'w');
  let n = 0;
  for (const d of docs.values()) if (d.a === acc) { fs.writeSync(out, JSON.stringify(d) + '\n'); n++; }
  fs.closeSync(out);
  fs.renameSync(tmp, fileOf(acc));
  files.set(acc, { lines: n, live: n });
}
function add(acc, list) {
  let text = '';
  for (const d of list) {
    if (!d || !d.k) continue;
    if (docs.has(d.k)) { try { index.discard(d.k); } catch (e) { /* not there */ } }
    docs.set(d.k, d);
    try { index.add(d); } catch (e) { /* a duplicate in the same batch */ }
    text += JSON.stringify(d) + '\n';
  }
  if (text) { fs.appendFileSync(fileOf(acc), text); const s = files.get(acc) || { lines: 0, live: 0 }; s.lines += list.length; files.set(acc, s); }
}
function remove(acc, keys) {
  let text = '';
  for (const k of keys) {
    if (!docs.has(k)) continue;
    docs.delete(k);
    try { index.discard(k); } catch (e) { /* not there */ }
    text += JSON.stringify({ '-': k }) + '\n';
  }
  if (text) fs.appendFileSync(fileOf(acc), text);
}
function drop(acc) {
  for (const [k, d] of docs) if (d.a === acc) { docs.delete(k); try { index.discard(k); } catch (e) { /* not there */ } }
  try { fs.unlinkSync(fileOf(acc)); } catch (e) { /* none */ }
  files.delete(acc);
}

// ----- Understanding what was typed -----
// Besides plain words, a search can say who, when and what kind, either in Outlook's short form (from:peter
// has:attachment before:2026-06-01) or in ordinary words ("from peter last month with a pdf").
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function parse(q, skip = []) {
  const out = { text: '', phrases: [], from: [], to: [], subject: [], has: false, unread: false, after: 0, before: 0, chips: [] };
  let s = ' ' + String(q || '').replace(/[“”]/g, '"') + ' ';
  const now = new Date(), today = dayStart(now);
  const chip = (k, label) => out.chips.push({ k, label });
  const take = (re, fn) => { s = s.replace(re, (...m) => { const r = fn(...m); return r === false ? m[0] : ' '; }); };
  const fmt = d => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  const range = (a, b, label) => { if (out.after || out.before) return false; out.after = a ? a.getTime() : 0; out.before = b ? b.getTime() : 0; chip('date', label || `${a ? fmt(a) : ''}${a && b ? ' to ' : ''}${b ? (a ? '' : 'Before ') + fmt(new Date(b.getTime() - 1)) : ' onwards'}`); };
  // Outlook's short form.
  take(/\s(from|to|subject):("([^"]+)"|(\S+))/gi, (_m, k, _v, a, b) => { out[k.toLowerCase()].push((a || b).toLowerCase()); chip(k.toLowerCase(), `${k[0].toUpperCase() + k.slice(1).toLowerCase()}: ${a || b}`); });
  take(/\s(has:attachments?|hasattachments?:(true|yes))(?=\s)/gi, () => { out.has = true; chip('has', 'Has an attachment'); });
  take(/\sis:unread(?=\s)/gi, () => { out.unread = true; chip('unread', 'Unread'); });
  take(/\s(before|after|since):(\d{4})-(\d\d?)-(\d\d?)(?=\s)/gi, (_m, k, y, mo, d) => { const dt = new Date(+y, +mo - 1, +d); if (isNaN(dt)) return false; if (/before/i.test(k)) { out.before = dt.getTime(); chip('date', `Before ${fmt(dt)}`); } else { out.after = dt.getTime(); chip('date', `Since ${fmt(dt)}`); } });
  // Exact phrases stay exact.
  take(/"([^"]+)"/g, (_m, p) => { if (p.trim()) out.phrases.push(p.trim().toLowerCase()); });
  // Ordinary words. ("Last week" and the like reach from then until now: people use them loosely, and missing the
  // email is worse than showing a few extra.)
  if (!skip.includes('date')) {
    take(/\s(today)(?=\s)/i, () => range(today, null, 'Today'));
    take(/\s(yesterday)(?=\s)/i, () => range(new Date(today.getTime() - 86400e3), today, 'Yesterday'));
    take(/\s(this|last|past)\s+week(?=\s)/i, (_m, w) => { const mon = new Date(today); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7)); if (/this/i.test(w)) return range(mon, null, 'This week'); const a = new Date(mon); a.setDate(a.getDate() - 7); return range(a, null, 'Since last week'); });
    take(/\s(this|last|past)\s+month(?=\s)/i, (_m, w) => { const a = new Date(today.getFullYear(), today.getMonth(), 1); if (/this/i.test(w)) return range(a, null, 'This month'); return range(new Date(a.getFullYear(), a.getMonth() - 1, 1), null, 'Since last month'); });
    take(/\s(this|last|past)\s+year(?=\s)/i, (_m, w) => { const a = new Date(today.getFullYear(), 0, 1); if (/this/i.test(w)) return range(a, null, 'This year'); return range(new Date(a.getFullYear() - 1, 0, 1), null, 'Since last year'); });
    take(/\s(?:in\s+the\s+)?(?:last|past)\s+(\d{1,3})\s+(day|week|month|year)s?(?=\s)/i, (_m, n, u) => { const a = new Date(today); if (/day/i.test(u)) a.setDate(a.getDate() - n); else if (/week/i.test(u)) a.setDate(a.getDate() - 7 * n); else if (/month/i.test(u)) a.setMonth(a.getMonth() - n); else a.setFullYear(a.getFullYear() - n); return range(a, null, `Last ${n} ${u.toLowerCase()}${+n === 1 ? '' : 's'}`); });
    take(new RegExp(`\\s(?:in\\s+|during\\s+)?(${MONTHS.join('|')}|${MONTHS.map(m => m.slice(0, 3)).join('|')})\\.?(?:\\s+(20\\d\\d))?(?=\\s)`, 'i'), (_m, mo, y) => {
      const i = MONTHS.findIndex(m => m.startsWith(mo.toLowerCase().slice(0, 3)));
      if (!y && /^may$/i.test(mo)) return false;                                   // "may" is usually just a word
      let yr = y ? +y : today.getFullYear(); if (!y && new Date(yr, i, 1) > today) yr--;
      return range(new Date(yr, i, 1), new Date(yr, i + 1, 1), `${MONTHS[i][0].toUpperCase() + MONTHS[i].slice(1)} ${yr}`);
    });
    take(/\s(?:in|during|from)\s+(20\d\d)(?=\s)/i, (_m, y) => range(new Date(+y, 0, 1), new Date(+y + 1, 0, 1), y));
  }
  if (!skip.includes('from')) take(/\sfrom\s+([a-z][\w.'@-]{1,40})(?=\s)/i, (_m, who) => { if (/^(the|a|an|my|our|your|last|this|that|me|us|you|them|him|her)$/i.test(who)) return false; out.from.push(who.toLowerCase()); chip('from', `From: ${who}`); });
  if (!skip.includes('has')) {
    take(/\s(?:with|has|have|having)\s+(?:an?\s+|the\s+)?(attachments?|pdfs?|files?|documents?|spreadsheets?)(?=\s)/i, () => { out.has = true; chip('has', 'Has an attachment'); });
    take(/\sattach(?:ed|ment|ments)(?=\s)/i, () => { out.has = true; chip('has', 'Has an attachment'); });
  }
  if (!skip.includes('unread')) take(/\sunread(?=\s)/i, () => { out.unread = true; chip('unread', 'Unread'); });
  // Small words that only make sense in a sentence are dropped from what is searched for.
  out.text = s.replace(/\s(the|a|an|email|emails|message|messages|mail|about|regarding|re|that|which|where|i|me|my|sent|got|received|find|show|and|of|on|for)(?=\s)/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!out.text && !out.phrases.length && !out.chips.length) out.text = String(q || '').trim();
  return out;
}

function search(q, opt = {}) {
  const P = parse(q, opt.skip || []);
  const accs = opt.accs && opt.accs.length ? new Set(opt.accs) : null;
  const pass = d => {
    if (!d) return false;
    if (accs && !accs.has(d.a)) return false;
    if (opt.folder && d.f !== opt.folder) return false;
    if (P.has && !d.h) return false;
    if (P.unread && d.r) return false;
    if (P.after && d.d < P.after) return false;
    if (P.before && d.d >= P.before) return false;
    if (P.from.length && !P.from.every(v => (d.w || '').toLowerCase().includes(v))) return false;
    if (P.to.length && !P.to.every(v => (d.t || '').toLowerCase().includes(v))) return false;
    if (P.subject.length && !P.subject.every(v => (d.s || '').toLowerCase().includes(v))) return false;
    if (P.phrases.length) { const all = `${d.s || ''}\n${d.x || d.p || ''}`.toLowerCase(); if (!P.phrases.every(p => all.includes(p))) return false; }
    return true;
  };
  const now = Date.now();
  let hits = [];
  const words = [P.text, ...P.phrases].filter(Boolean).join(' ');
  if (words) {
    const run = combineWith => index.search(words, { combineWith, prefix: t => t.length > 2, fuzzy: t => (t.length > 3 ? 0.25 : 0), boost: { s: 3, w: 2, t: 1.2 }, filter: r => pass(docs.get(r.id)) });
    let found = run('AND');
    let loose = false;
    if (!found.length && words.split(/\s+/).length > 1) { found = run('OR'); loose = true; }
    hits = found.map(r => { const d = docs.get(r.id); return { d, terms: r.terms, score: r.score * (1 + 0.35 * Math.exp(-(now - d.d) / (365 * 86400e3))) }; });
    P.loose = loose;
  } else {
    for (const d of docs.values()) if (pass(d)) hits.push({ d, terms: [], score: d.d });
  }
  const total = hits.length;
  if (opt.sort === 'date' || !words) hits.sort((a, b) => b.d.d - a.d.d); else hits.sort((a, b) => b.score - a.score);
  hits = hits.slice(0, Math.max(1, Math.min(500, opt.limit || 150)));
  const snippet = (d, terms) => {
    const text = d.x || d.p || '';
    const low = text.toLowerCase();
    let at = -1;
    for (const t of [...P.phrases, ...terms]) { const i = low.indexOf(String(t).toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
    if (at < 60) return text.slice(0, 220);
    return '…' + text.slice(at - 50, at + 170);
  };
  return {
    total, chips: P.chips, loose: !!P.loose, parsed: { text: P.text, phrases: P.phrases, from: P.from, to: P.to, subject: P.subject, has: P.has, unread: P.unread, after: P.after, before: P.before },
    results: hits.map(({ d, terms }) => ({
      id: d.i, _acc: d.a, _folder: d.f, subject: d.s, from: { emailAddress: { name: d.fn || '', address: d.fa || '' } }, _to: d.t || '',
      receivedDateTime: new Date(d.d).toISOString(), bodyPreview: snippet(d, terms), isRead: !!d.r, hasAttachments: !!d.h, isDraft: !!d.dr, conversationId: d.c || '',
      flag: { flagStatus: 'notFlagged' },
    })),
  };
}
function counts() { const n = {}; for (const d of docs.values()) n[d.a] = (n[d.a] || 0) + 1; return n; }

process.parentPort.on('message', async e => {
  const m = e.data || {};
  const reply = data => process.parentPort.postMessage({ id: m.id, data });
  try {
    if (m.op === 'init') { dir = m.dir; await loadAll(); return reply({ ok: true, counts: counts() }); }
    if (!loaded && m.op !== 'parse') return reply({ ok: false, loading: true });
    if (m.op === 'add') { add(m.acc, m.docs || []); return reply({ ok: true }); }
    if (m.op === 'remove') { remove(m.acc, m.keys || []); return reply({ ok: true }); }
    if (m.op === 'drop') { drop(m.acc); return reply({ ok: true }); }
    if (m.op === 'dropFolder') { const keys = []; for (const [k, d] of docs) if (d.a === m.acc && d.f === m.folder) keys.push(k); remove(m.acc, keys); return reply({ ok: true, removed: keys.length }); }
    if (m.op === 'counts') return reply({ ok: true, counts: counts() });
    if (m.op === 'texts') { const out = {}; for (const k of m.keys || []) { const d = docs.get(k); if (d) out[k] = d.x || d.p || ''; } return reply({ ok: true, texts: out }); }
    if (m.op === 'parse') return reply({ ok: true, parsed: parse(m.q, m.skip || []) });
    if (m.op === 'search') return reply(Object.assign({ ok: true }, search(m.q, m.opt || {})));
    reply({ ok: false, error: 'Unknown' });
  } catch (err) {
    reply({ ok: false, error: String(err && err.message || err) });
  }
});

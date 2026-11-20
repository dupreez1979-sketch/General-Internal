// Reads the look of a Claude design system page: its colours and fonts.
// Claude shows a design system inside one or more frames, so every frame on the page is read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Runs inside each frame. Collects colour variables, hex codes written on the page, the colours used
// over the largest areas, the heading and body fonts, and the page's @font-face rules.
const FRAME_SCRIPT = `(async () => {
  const out = { vars: [], text: [], areas: [], head: [], body: [], faces: [], title: document.title || '' };
  const probe = document.createElement('i'); probe.style.display = 'none'; (document.body || document.documentElement).appendChild(probe);
  const toRgb = v => { probe.style.color = ''; probe.style.color = v; if (!probe.style.color) return null; return getComputedStyle(probe).color; };
  const sheets = [];
  for (const s of document.styleSheets) {
    try { sheets.push({ rules: s.cssRules, base: s.href || location.href }); }
    catch (e) { if (s.href) { try { const t = await (await fetch(s.href)).text(); const st = new CSSStyleSheet(); st.replaceSync(t.replace(/@import[^;]+;/g, '')); sheets.push({ rules: st.cssRules, base: s.href }); } catch (e2) {} } }
  }
  const walk = (rules, base) => { for (const r of rules || []) {
    if (r.cssRules && !(r instanceof CSSFontFaceRule) && !r.selectorText) walk(r.cssRules, base);
    if (r instanceof CSSFontFaceRule) {
      const fam = r.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
      const src = r.style.getPropertyValue('src');
      const urls = [...src.matchAll(/url\\(\\s*["']?([^"')]+)["']?\\s*\\)\\s*(?:format\\(\\s*["']?([\\w-]+)["']?\\s*\\))?/g)].map(m => { try { return { url: new URL(m[1], base).href, format: m[2] || '' }; } catch (e) { return null; } }).filter(Boolean);
      if (fam && urls.length) out.faces.push({ family: fam, weight: r.style.getPropertyValue('font-weight') || '400', style: r.style.getPropertyValue('font-style') || 'normal', urls });
    } else if (r.selectorText && /(^|,)\\s*(:root|html|body|\\[data-theme[^\\]]*\\]|\\.theme[\\w-]*)\\s*(,|$)/.test(r.selectorText)) {
      for (let i = 0; i < r.style.length; i++) {
        const name = r.style[i]; if (!name.startsWith('--')) continue;
        const raw = r.style.getPropertyValue(name).trim();
        const val = raw.startsWith('var(') ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : raw;
        const rgb = /^(#|rgb|hsl|oklch|lab|lch|color\\()/i.test(val) ? toRgb(val) : null;
        if (rgb) out.vars.push({ name, rgb });
      }
    }
  } };
  for (const s of sheets) walk(s.rules, s.base);
  // Hex codes written on the page, with the words around them as a label ("Dark Teal #1B5A68").
  const text = (document.body && document.body.innerText) || '';
  for (const line of text.split(/\\n+/).slice(0, 4000)) {
    for (const m of line.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\\b/gi)) {
      const label = line.replace(m[0], '').replace(/[#:|,\\-–]+/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 40);
      out.text.push({ rgb: toRgb(m[0]), label });
    }
  }
  // Colours used over the largest areas (swatches, panels, buttons).
  const area = new Map();
  const els = document.querySelectorAll('body *'); let n = 0;
  for (const el of els) {
    if (++n > 6000) break;
    const cs = getComputedStyle(el); const b = el.getBoundingClientRect(); const a = b.width * b.height;
    if (!a || cs.visibility === 'hidden') continue;
    const bg = cs.backgroundColor; if (bg && !/rgba\\(.*, 0\\)$/.test(bg) && bg !== 'transparent') area.set(bg, (area.get(bg) || 0) + a);
  }
  out.areas = [...area].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([rgb, a]) => ({ rgb, a }));
  const fam = sel => [...document.querySelectorAll(sel)].slice(0, 40).map(e => getComputedStyle(e).fontFamily).filter(Boolean);
  out.head = fam('h1, h2, h3');
  out.body = fam('p, li, td, body');
  probe.remove();
  return out;
})()`;

const rgbToHex = s => {
  const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/.exec(s || '');
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) < (m[4].endsWith('%') ? 60 : 0.6)) return null; // see-through
  return '#' + [m[1], m[2], m[3]].map(x => Math.round(+x).toString(16).padStart(2, '0')).join('').toUpperCase();
};
const hsl = hex => {
  const v = parseInt(hex.slice(1), 16); const r = (v >> 16) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  return { s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
};
const dist = (a, b) => { const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16); return Math.abs((x >> 16) - (y >> 16)) + Math.abs(((x >> 8) & 255) - ((y >> 8) & 255)) + Math.abs((x & 255) - (y & 255)); };
const firstFamily = list => {
  const count = new Map();
  for (const f of list) { const name = f.split(',')[0].replace(/["']/g, '').trim(); if (name && !/^(-apple-system|system-ui|ui-sans-serif|sans-serif|serif|inherit|initial)$/i.test(name)) count.set(name, (count.get(name) || 0) + 1); }
  return [...count].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || '';
};
const prettyVar = n => n.replace(/^--/, '').replace(/^(color|colour|clr|c|brand|ds|theme)[-_]/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// Turns what the frames found into a palette and a pair of fonts.
function summarise(frames) {
  const score = new Map();   // hex -> { hex, label, score }
  const add = (hex, label, pts) => {
    if (!hex) return;
    const near = [...score.values()].find(c => dist(c.hex, hex) < 18);
    const c = near || { hex, label: '', score: 0 };
    if (!near) score.set(hex, c);
    if (label && (!c.label || c.label.length > label.length && label.length > 2)) c.label = label;
    c.score += pts;
  };
  for (const f of frames) {
    for (const v of f.vars) add(rgbToHex(v.rgb), prettyVar(v.name), 3);
    for (const t of f.text) add(rgbToHex(t.rgb), t.label, 4);
    const total = f.areas.reduce((s, a) => s + a.a, 0) || 1;
    for (const a of f.areas) add(rgbToHex(a.rgb), '', 6 * a.a / total);
  }
  const all = [...score.values()].filter(c => c.score >= 1).sort((a, b) => b.score - a.score);
  const colours = all.slice(0, 16).map(c => ({ hex: c.hex, label: c.label, ...hsl(c.hex) }));
  const strong = colours.filter(c => c.s > 0.25 && c.l > 0.12 && c.l < 0.75);
  const accent = (strong[0] || colours[0] || {}).hex || '';
  const second = (strong.find(c => accent && dist(c.hex, accent) > 120) || {}).hex || '';
  const head = firstFamily(frames.flatMap(f => f.head));
  const body = firstFamily(frames.flatMap(f => f.body));
  const faces = frames.flatMap(f => f.faces);
  return {
    colours: colours.map(({ hex, label }) => ({ hex, label })), accent, second,
    headFont: head || body, bodyFont: body || head,
    faces, title: (frames.find(f => f.title) || {}).title || '',
  };
}

// Saves the font files the page uses (only for the chosen fonts), so the app can show them offline.
async function saveFonts(ses, faces, families, dir) {
  const want = new Set(families.filter(Boolean).map(f => f.toLowerCase()));
  const out = [];
  fs.mkdirSync(dir, { recursive: true });
  for (const face of faces.filter(f => want.has(f.family.toLowerCase())).slice(0, 12)) {
    const pick = face.urls.find(u => /woff2/i.test(u.format || u.url)) || face.urls.find(u => /woff/i.test(u.format || u.url)) || face.urls[0];
    try {
      let buf;
      if (pick.url.startsWith('data:')) buf = Buffer.from(pick.url.split(',')[1] || '', /;base64/.test(pick.url) ? 'base64' : 'utf8');
      else if (/^https:/.test(pick.url)) { const r = await ses.fetch(pick.url); if (!r.ok) continue; buf = Buffer.from(await r.arrayBuffer()); }
      else continue;
      if (!buf.length || buf.length > 3e6) continue;
      const ext = (/woff2/i.test(pick.format || pick.url) ? 'woff2' : /woff/i.test(pick.format || pick.url) ? 'woff' : /otf|opentype/i.test(pick.format || pick.url) ? 'otf' : 'ttf');
      const file = path.join(dir, crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + ext);
      if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
      out.push({ family: face.family, weight: face.weight, style: face.style, file });
    } catch (e) { /* a font that will not download is skipped; the name is still used */ }
  }
  return out;
}

async function readLook(webContents, ses, fontDir) {
  const frames = [];
  for (const fr of webContents.mainFrame.framesInSubtree) {
    try { const r = await fr.executeJavaScript(FRAME_SCRIPT, true); if (r) frames.push(r); } catch (e) { /* frame went away */ }
  }
  const look = summarise(frames);
  look.fonts = await saveFonts(ses, look.faces, [look.headFont, look.bodyFont], fontDir);
  delete look.faces;
  look.readAt = Date.now();
  return look;
}

module.exports = { readLook, summarise };

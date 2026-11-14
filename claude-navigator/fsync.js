// Keeps the app's folders as real folders on disk (by default Documents/Claude Navigator).
//
//  - Profiles are the top-level folders; your folders sit inside them.
//  - A Claude chat, artifact or other link is a small ".webloc" file (".url" on Windows) holding its address,
//    so Finder shows it and double-clicking opens it in a browser.
//  - Any other file (Word, Excel, PDF, images...) is just a normal file and opens in its own app.
//  - Changes made in the app are applied to disk; changes made in Finder are reported back to the app.
//  - Deleting always moves things to the Trash.

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

const isMac = process.platform === 'darwin';
const LINK_EXT = isMac ? '.webloc' : '.url';
const LINK_EXTS = ['.webloc', '.url'];

// Characters folders and files cannot have, and names Finder hides.
function safeName(name) {
  let s = String(name || 'Untitled').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').slice(0, 120).trim();
  return s || 'Untitled';
}

function linkFileContents(url) {
  if (LINK_EXT === '.url') return `[InternetShortcut]\r\nURL=${url}\r\n`;
  const esc = String(url).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>URL</key>\n\t<string>${esc}</string>\n</dict>\n</plist>\n`;
}

function readLinkFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = /<string>([\s\S]*?)<\/string>/.exec(text) || /^URL=(.*)$/m.exec(text);
    if (!m) return '';
    const url = m[1].trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return /^https?:\/\//i.test(url) ? url : '';     // web links only: never file:, javascript: or app links

  } catch (e) { return ''; }
}

const statIno = p => { try { return String(fs.lstatSync(p).ino); } catch (e) { return null; } };
const isDir = p => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch (e) { return false; } };
const exists = p => { try { fs.accessSync(p); return true; } catch (e) { return false; } };

class FolderSync {
  constructor(root) {
    this.root = root;
    this.quietUntil = 0;
    this.watcher = null;
    this.onChange = null;
  }

  ensureRoot() { fs.mkdirSync(this.root, { recursive: true }); }

  // A path inside the synced folder. Refuses anything that leads outside it, by name or through a shortcut (symlink).
  abs(rel) {
    const p = path.resolve(this.root, rel || '');
    if (p !== this.root && !p.startsWith(this.root + path.sep)) throw new Error('outside the synced folder');
    let real = null, probe = p;
    while (!real && probe.length >= this.root.length) {
      try { real = fs.realpathSync(probe); } catch (e) { probe = path.dirname(probe); }
    }
    let rootReal = this.root;
    try { rootReal = fs.realpathSync(this.root); } catch (e) { /* not made yet */ }
    if (real && real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error('outside the synced folder');
    return p;
  }
  rel(abs) { return path.relative(this.root, abs).split(path.sep).join('/'); }

  // Everything on disk, parents before children. Hidden files are skipped.
  // Throws if the folder itself cannot be read (for example macOS has not allowed access to Documents,
  // or a drive is not connected), so an unreadable folder is never mistaken for an empty one.
  scan() {
    fs.readdirSync(this.root);        // never recreated here: a missing folder is reported, not replaced by an empty one
    const out = [];
    const walk = (dir, parentRel) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { out.unreadable = true; return; }
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'Icon\r' || e.name === 'desktop.ini' || e.name === 'Thumbs.db') continue;
        const abs = path.join(dir, e.name);
        const rel = this.rel(abs);
        let st;
        try { st = fs.lstatSync(abs); } catch (err) { continue; }
        if (st.isSymbolicLink()) continue;              // shortcuts can point outside: leave them alone
        const ext = path.extname(e.name).toLowerCase();
        if (st.isDirectory()) {
          // macOS packages (for example .pages or .key documents) are files, not folders.
          if (/\.(app|pages|numbers|key|rtfd|bundle|photoslibrary)$/i.test(e.name)) {
            out.push({ rel, parentRel, kind: 'file', name: e.name, ext, ino: String(st.ino), size: 0, mtime: st.mtime.toISOString() });
            continue;
          }
          out.push({ rel, parentRel, kind: 'dir', name: e.name, ino: String(st.ino), mtime: st.mtime.toISOString() });
          walk(abs, rel);
        } else if (LINK_EXTS.includes(ext)) {
          out.push({ rel, parentRel, kind: 'link', name: e.name.slice(0, -ext.length), url: readLinkFile(abs), ino: String(st.ino), mtime: st.mtime.toISOString() });
        } else {
          out.push({ rel, parentRel, kind: 'file', name: e.name, ext, ino: String(st.ino), size: st.size, mtime: st.mtime.toISOString() });
        }
      }
    };
    walk(this.root, null);
    return out;
  }

  // Makes disk match the app. `nodes` are in tree order (parents first): { id, type, name, url, parentId, path }.
  // `trash` lists paths of things deleted in the app. Returns where each node now lives.
  async apply({ nodes = [], trash = [] }) {
    if (!isDir(this.root)) return { map: {}, errors: [], unreachable: true };
    this.quietUntil = Date.now() + 2000;
    const result = {};
    const errors = [];
    const moved = [];                       // [oldAbsPrefix, newAbsPrefix] for folders already moved
    const translate = p => {          // follow every folder move made so far, including moves inside moves
      for (let guard = 0, again = true; again && guard < 50; guard++) {
        again = false;
        for (const [from, to] of moved) if (p === from || p.startsWith(from + path.sep)) { const q = to + p.slice(from.length); if (q !== p) { p = q; again = true; } break; }
      }
      return p;
    };
    const dirOf = new Map();                // node id -> folder on disk its children live in
    const taken = new Map();                // folder -> names used this pass (lower case)
    // `adopt(path)`: true if something already there is this very item (a folder of that name, or a link to that
    // address), so a folder that already exists is used rather than a second "Name 2" being made beside it.
    const claim = (dir, base, current, adopt) => {
      const used = taken.get(dir) || new Set();
      const ext = path.extname(base);
      const stem = ext && !base.startsWith('.') ? base.slice(0, -ext.length) : base;
      let name = base;
      for (let i = 2; ; i++) {
        const candidate = path.join(dir, name);
        const free = !used.has(name.toLowerCase()) &&
          (!exists(candidate) || (current && statIno(candidate) === statIno(current)) || (!current && adopt && adopt(candidate)));
        if (free) break;
        name = `${stem} ${i}${ext}`;
      }
      used.add(name.toLowerCase());
      taken.set(dir, used);
      return path.join(dir, name);
    };

    for (const n of nodes) {
      try {
        const parentDir = n.parentId ? dirOf.get(n.parentId) : this.root;
        if (!parentDir) continue;
        const current = n.path ? translate(this.abs(n.path)) : null;
        const currentOk = current && exists(current);
        let base;
        if (n.type === 'folder') base = safeName(n.name);
        else if (n.type === 'link') base = safeName(n.name) + (current && LINK_EXTS.includes(path.extname(current).toLowerCase()) ? path.extname(current) : LINK_EXT);
        else {
          // A normal file keeps its extension even if you rename it without one.
          const ext = path.extname(current || n.name || '');
          const stem = safeName(n.name).replace(new RegExp(`${ext.replace('.', '\\.')}$`, 'i'), '');
          base = stem + ext;
        }
        const adopt = n.type === 'folder' ? isDir : n.type === 'link' ? (c => !!n.url && readLinkFile(c) === n.url) : null;
        const desired = claim(parentDir, base, currentOk ? current : null, adopt);
        fs.mkdirSync(parentDir, { recursive: true });
        if (currentOk) {
          if (current !== desired) {
            if (current.toLowerCase() === desired.toLowerCase()) {   // only the capitals changed
              const tmp = desired + '.renaming';
              fs.renameSync(current, tmp);
              fs.renameSync(tmp, desired);
            } else {
              fs.renameSync(current, desired);
            }
            if (n.type === 'folder') moved.push([current, desired]);
          }
          if (n.type === 'link' && n.url && readLinkFile(desired) !== n.url) fs.writeFileSync(desired, linkFileContents(n.url));
        } else if (n.type === 'folder') {
          fs.mkdirSync(desired, { recursive: true });
        } else if (n.type === 'link') {
          if (!exists(desired)) fs.writeFileSync(desired, linkFileContents(n.url || ''));
        } else {
          result[n.id] = { missing: true };       // a normal file the app cannot recreate
          continue;
        }
        dirOf.set(n.id, n.type === 'folder' ? desired : parentDir);
        result[n.id] = { path: this.rel(desired), ino: statIno(desired) };
      } catch (e) {
        errors.push(`${n.name}: ${e.message}`);
      }
    }

    // Only what you deleted in the app goes to the Trash, never the synced folder itself, and never
    // something that is still in use (for example after Undo brought it back).
    const inUse = new Set(Object.values(result).filter(r => r.path).map(r => path.join(this.root, r.path)));
    for (const rel of trash) {
      try {
        if (!rel) continue;
        const p = translate(this.abs(rel));
        if (p === this.root || inUse.has(p) || [...inUse].some(u => u.startsWith(p + path.sep))) continue;
        if (exists(p)) await shell.trashItem(p);
      } catch (e) { errors.push(`${rel}: ${e.message}`); }
    }
    this.quietUntil = Date.now() + 2000;
    return { map: result, errors };
  }

  // Copies a file or folder: next to itself as "Name copy", or into another folder keeping its name.
  copy(srcRel, destDirRel, keepName) {
    const src = this.abs(srcRel);
    if (!exists(src)) return { error: 'it is no longer there' };
    const dir = destDirRel != null ? this.abs(destDirRel) : path.dirname(src);
    const base = path.basename(src);
    const ext = fs.lstatSync(src).isDirectory() ? '' : path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let name = keepName ? base : `${stem} copy${ext}`;
    for (let i = 2; exists(path.join(dir, name)); i++) name = `${stem}${keepName ? '' : ' copy'} ${i}${ext}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(src, path.join(dir, name), { recursive: true });
    return { rel: this.rel(path.join(dir, name)) };
  }

  // Copies files dropped into the app (from Finder or the desktop) into a folder.
  async importFiles(paths, destRel) {
    const dest = this.abs(destRel || '');
    fs.mkdirSync(dest, { recursive: true });
    const done = [];
    for (const src of paths || []) {
      try {
        const base = path.basename(src);
        const ext = path.extname(base);
        let target = path.join(dest, base);
        for (let i = 2; exists(target); i++) target = path.join(dest, `${base.slice(0, base.length - ext.length)} ${i}${ext}`);
        fs.cpSync(src, target, { recursive: true });
        done.push(this.rel(target));
      } catch (e) { /* skip files that cannot be copied */ }
    }
    return done;
  }

  watch(onChange) {
    this.onChange = onChange;
    this.unwatch();
    this.ensureRoot();
    let timer = null;
    try {
      // Changes right after the app's own writes are checked once those writes settle, never dropped:
      // checking is harmless when nothing changed, and Finder changes made in that moment still come through.
      const fire = () => {
        const wait = this.quietUntil - Date.now();
        if (wait > 0) { timer = setTimeout(fire, wait + 100); return; }
        if (this.onChange) this.onChange();
      };
      this.watcher = fs.watch(this.root, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(fire, 600);
      });
      // If the folder disappears (deleted, or its drive is unplugged) stop watching instead of crashing.
      this.watcher.on('error', () => { this.unwatch(); if (this.onChange) this.onChange(); });
    } catch (e) {
      // No recursive watching on this system: check every 5 seconds instead.
      let last = '';
      this.poll = setInterval(() => {
        let sig = '';
        try { sig = JSON.stringify(this.scan().map(e => [e.rel, e.mtime])); } catch (err) { return; }
        if (last && sig !== last && Date.now() >= this.quietUntil && this.onChange) this.onChange();
        last = sig;
      }, 5000);
    }
  }

  unwatch() {
    if (this.watcher) { try { this.watcher.close(); } catch (e) { /* ignore */ } this.watcher = null; }
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
  }
}

module.exports = { FolderSync, safeName, LINK_EXT, linkFileContents };

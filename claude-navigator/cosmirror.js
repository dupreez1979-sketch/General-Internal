// Mirrors Chief of Staff to real folders (by default Documents/Claude Navigator Chief of Staff):
//   Profile / Staff member / Project / ...   links as .webloc files, your files as aliases (symlinks) to the originals,
//   and an "About" note per staff member with their role, actions, functions and routines.
//
// One way only: the app is the source and the mirror is rewritten to match. Safety rules:
//  - It only changes or removes things it made itself (listed in .cos-mirror.json in the mirror folder).
//  - Anything you put there yourself is left alone; a name already taken by your own file is skipped.
//  - Removed items go to the Trash.
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { safeName, LINK_EXT, linkFileContents } = require('./fsync');

const MANIFEST = '.cos-mirror.json';
const lstat = p => { try { return fs.lstatSync(p); } catch (e) { return null; } };

class CosMirror {
  constructor(root) { this.root = path.resolve(root); }
  inside(p) { const r = path.resolve(p); return r === this.root || r.startsWith(this.root + path.sep); }

  // tree: [{ name, type: 'dir' | 'link' | 'file' | 'text', children?, url?, src? (absolute, already checked), text? }]
  async apply(tree) {
    const top = lstat(this.root);
    if (top && (top.isSymbolicLink() || !top.isDirectory())) throw new Error('The mirror folder is not a normal folder');
    fs.mkdirSync(this.root, { recursive: true });
    let old = { files: [], dirs: [] };
    try { old = JSON.parse(fs.readFileSync(path.join(this.root, MANIFEST), 'utf8')); } catch (e) { /* first run */ }
    const ours = new Set([...(old.files || []), ...(old.dirs || [])]);
    const files = new Set(), dirs = new Set(), skipped = [];

    const place = (list, relDir) => {
      const used = new Set();
      for (const e of list || []) {
        let base = safeName(e.name);
        const ext = e.type === 'link' ? LINK_EXT : e.type === 'text' ? '.md' : e.type === 'file' ? path.extname(e.src || '') : '';
        if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length) || 'Untitled';
        let name = base + ext, i = 2;
        while (used.has(name.toLowerCase())) name = `${base} ${i++}${ext}`;
        used.add(name.toLowerCase());
        const rel = relDir ? path.join(relDir, name) : name;
        const abs = path.join(this.root, rel);
        if (!this.inside(abs)) continue;
        const st = lstat(abs);
        if (e.type === 'dir') {
          if (st && (!st.isDirectory() || st.isSymbolicLink())) { skipped.push(rel); continue; }
          if (!st) fs.mkdirSync(abs);
          dirs.add(rel);
          place(e.children, rel);
          continue;
        }
        if (st && !ours.has(rel)) { skipped.push(rel); continue; }   // someone else's file: leave it
        try {
          if (e.type === 'file') {
            if (!e.src || !lstat(e.src)) continue;
            if (st && st.isSymbolicLink() && fs.readlinkSync(abs) === e.src) { files.add(rel); continue; }
            if (st) fs.unlinkSync(abs);
            fs.symlinkSync(e.src, abs);
          } else {
            const body = e.type === 'link' ? linkFileContents(e.url) : String(e.text || '');
            if (st && st.isSymbolicLink()) fs.unlinkSync(abs);
            let cur = null; try { cur = fs.readFileSync(abs, 'utf8'); } catch (x) { /* new */ }
            if (cur !== body) fs.writeFileSync(abs, body);
          }
          files.add(rel);
        } catch (x) { skipped.push(rel); }
      }
    };
    place(tree, '');

    // Take away what we made before and no longer want (files first, then folders that are now empty).
    let trashed = 0;
    for (const rel of old.files || []) {
      if (files.has(rel)) continue;
      const abs = path.join(this.root, rel);
      if (!this.inside(abs) || !lstat(abs)) continue;
      try { await shell.trashItem(abs); trashed++; } catch (e) { /* in use: try again next time */ }
    }
    for (const rel of (old.dirs || []).slice().sort((a, b) => b.length - a.length)) {
      if (dirs.has(rel)) continue;
      const abs = path.join(this.root, rel);
      const st = lstat(abs);
      if (!this.inside(abs) || !st || !st.isDirectory()) continue;
      const left = fs.readdirSync(abs).filter(n => n !== '.DS_Store');
      if (!left.length) { try { await shell.trashItem(abs); } catch (e) { /* ignore */ } }
      else dirs.add(rel);       // still holds your own things: keep it (and keep treating it as ours)
    }
    fs.writeFileSync(path.join(this.root, MANIFEST), JSON.stringify({ files: [...files], dirs: [...dirs], at: Date.now() }, null, 1));
    return { ok: true, files: files.size, dirs: dirs.size, skipped, trashed };
  }
}
module.exports = { CosMirror };

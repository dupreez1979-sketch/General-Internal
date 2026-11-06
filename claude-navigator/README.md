# Claude Navigator

Your own front end for Claude: a Windows Explorer style folder tree on the left, the real claude.ai on the right.

Folders can nest as deep as you like. Each link points at a Claude chat, project, artifact, or any other page (Canva designs, Google Docs). Clicking a link opens it in Claude, signed in as you, so every Claude feature still works: projects, artifacts, connectors, Canva, design systems.

## Two ways to run it

### 1. Desktop app (recommended)

Claude sits inside the app, next to your folders.

1. Install Node.js LTS from nodejs.org (one time only).
2. Open a terminal in this `claude-navigator` folder and run:

```bash
npm install
```

```bash
npm start
```

3. Sign in to Claude in the right-hand pane. You stay signed in between launches.

To make a double-clickable Windows installer (and a portable `.exe`), run:

```bash
npm run build:win
```

The files appear in `dist/`. On a Mac use `npm run build:mac`.

**Sign-in tip:** if Google sign-in refuses to work inside the app, use "Continue with email" instead. Claude emails you a code.

### 2. Browser only

Double-click `index.html`. The folder tree works the same, but links open Claude in a separate browser tab, because claude.ai does not allow itself to be shown inside another web page.

## Using it

| To do this | Do this |
| --- | --- |
| Open a chat, project or artifact | Click it |
| Expand or collapse a folder | Click it, or use the arrow keys |
| New folder | Folder button, right-click a folder, or Ctrl+Shift+N |
| Save the Claude page you are looking at | Select a folder, then Save page (or Ctrl+S) |
| Start a chat that belongs in a folder | Right-click the folder, "New chat, then save here", then Save page once the chat has a title |
| Add a link by pasting | Link button or Ctrl+L |
| Move things | Drag onto a folder (drops inside) or between rows (reorders). Hovering over a closed folder opens it |
| Save a link from your browser | Drag it from the address bar onto a folder |
| Rename | F2, or right-click |
| Delete | Del. Undo with Ctrl+Z or the Undo button |
| Find something | Ctrl+F, then type |
| Open in a separate window | Ctrl+click or middle-click |
| Resize the tree | Drag the divider. Double-click it to reset |

## Your data

Folders are stored on your computer only, inside the app. Use the `...` menu, "Back up folders to a file", to save a copy. "Restore folders from a file" brings it back, including on another computer.

## Files

- `index.html`: the whole interface (tree, menus, dialogs). Edit this to change how it looks and behaves.
- `main.js`: the desktop app window and the Claude pane.
- `preload.js`: the small bridge between the two.

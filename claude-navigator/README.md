# Claude Navigator

Your own front end for Claude: a Windows Explorer style folder tree on the left, the real claude.ai on the right.

Folders can nest as deep as you like. Each link points at a Claude chat, project, artifact, or any other page (Canva designs, Google Docs). Clicking a link opens it in Claude, signed in as you, so every Claude feature still works: projects, artifacts, connectors, Canva, design systems.

## Two ways to run it

### 1. Mac app (recommended)

Claude sits inside the app, next to your folders.

**One-time setup**

1. Install Node.js: go to nodejs.org, download the **LTS** version for macOS, and run the installer.
2. Open **Terminal** (press ⌘Space, type Terminal, press Return).
3. Type `cd ` (with a space after it), drag the `claude-navigator` folder from Finder into the Terminal window, and press Return.
4. Run:

```bash
npm install
```

**Try it**

```bash
npm start
```

Sign in to Claude in the right-hand pane. You stay signed in between launches. Quit with ⌘Q.

**Make it a proper app in your Applications folder**

```bash
npm run build:mac
```

This makes two installers in the `dist` folder: one ending `-arm64.dmg` (for M1, M2, M3, M4 Macs) and one without it (for older Intel Macs). Open the right one and drag Claude Navigator into Applications. From then on it opens from Launchpad or Spotlight like any other app, and you can keep it in the Dock.

The first time you open it, macOS may say it cannot check the app for malicious software, because it is not signed with an Apple developer certificate. Go to **System Settings, Privacy & Security**, scroll down, and click **Open Anyway**. If it says the app "is damaged", run this once, then open it again:

```bash
xattr -cr "/Applications/Claude Navigator.app"
```

**Sign-in tip:** if Google sign-in refuses to work inside the app, use "Continue with email" instead. Claude emails you a code.

(Windows: same steps, using `npm run build:win`.)

### 2. Browser only

Double-click `index.html`. The folder tree works the same, but links open Claude in a separate browser tab, because claude.ai does not allow itself to be shown inside another web page.

## Using it

| To do this | Do this |
| --- | --- |
| Open a chat, project or artifact | Click it, or ⌘↓ |
| Expand or collapse a folder | Click it, or use the arrow keys |
| New folder | Folder button, right-click a folder, or ⌘⇧N |
| Save the Claude page you are looking at | Select a folder, then Save page (or ⌘S) |
| Start a chat that belongs in a folder | Right-click the folder, "New chat, then save here", then Save page once the chat has a title |
| Add a link by pasting | Link button or ⌘L |
| Move things | Drag onto a folder (drops inside) or between rows (reorders). Hovering over a closed folder opens it |
| Save a link from your browser | Drag it from the address bar onto a folder |
| Rename | Return, like Finder (or right-click) |
| Delete | ⌫. Undo with ⌘Z or the Undo button |
| Find something | ⌘F, then type |
| Open in a separate window | ⌘-click |
| Resize the tree | Drag the divider. Double-click it to reset |

On Windows the same shortcuts use Ctrl, F2 renames and Enter opens.

## Your data

Folders are stored on your computer only, inside the app. Use the `...` menu, "Back up folders to a file", to save a copy. "Restore folders from a file" brings it back, including on another computer.

## Files

- `index.html`: the whole interface (tree, menus, dialogs). Edit this to change how it looks and behaves.
- `main.js`: the desktop app window and the Claude pane.
- `preload.js`: the small bridge between the two.

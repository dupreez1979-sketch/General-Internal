# Claude Navigator

Your own front end for Claude, laid out like the Mac Finder: a sidebar of folders on the left, and a main window that shows either a folder's contents (as icons or a list) or Claude itself.

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

## How it works

It behaves like a Finder window:

- **Sidebar.** Your top-level folders are the grey section headings (like Favourites in Finder). Click a heading to hide or show it. Everything inside is a tree you can open with the small arrows.
- **Main window.** Click a folder and its contents appear as big icons or a list, with a path bar along the bottom. Double-click a folder to go into it. Double-click a chat, project or artifact and Claude opens in the main window, signed in, with all its features.
- **Back and forward** move between folders and Claude pages, just like Finder.
- **Saving.** While you are looking at a Claude page, the toolbar shows "Save to [folder]", meaning the folder you came from. Click it (or press ⌘S) to file the page there. The star turns gold once a page is saved somewhere.
- **New chat** (the pencil button, or ⌘N) starts a chat. Start it from inside a folder and ⌘S will save it into that folder.

| To do this | Do this |
| --- | --- |
| Open a folder | Click it in the sidebar, or double-click it in the main window |
| Open a chat, project or artifact | Click it in the sidebar, double-click it in the main window, or ⌘↓ |
| Go back, forward, up a level | ⌘[ , ⌘] , ⌘↑ |
| Icons or list | ⌘1 , ⌘2 |
| New folder | ⌘⇧N (in the folder you are looking at), or New Folder at the bottom of the sidebar |
| Save the Claude page you are looking at | ⌘S |
| Add a link by pasting | ⌘L |
| Rename | Select it, press Return (like Finder) |
| Delete | ⌘⌫. Undo with ⌘Z or the Undo button |
| Move things | Drag onto any folder, in the sidebar or the main window. Drag between sidebar rows to reorder |
| Save a link from your browser | Drag it from the address bar onto a folder |
| Find anything | ⌘F, then type. Results show which folder each item is in |
| Open in a separate window | ⌘-click |
| More options | Right-click anything, or empty space |

On Windows the same shortcuts use Ctrl, F2 renames and Enter opens.

## Your data

Folders are stored on your computer only, inside the app. Use the `...` menu, "Back up folders to a file", to save a copy. "Restore folders from a file" brings it back, including on another computer.

## Files

- `index.html`: the whole interface (tree, menus, dialogs). Edit this to change how it looks and behaves.
- `main.js`: the desktop app window and the Claude pane.
- `preload.js`: the small bridge between the two.

# Claude Navigator

Your own front end for Claude, laid out like the Mac Finder: a sidebar of folders on the left, and a main window that shows either a folder's contents (as icons or a list) or Claude itself.

Folders can nest as deep as you like. Each link points at a Claude chat, project, artifact, or any other page (Canva designs, Google Docs). Clicking a link opens it in Claude, signed in as you, so every Claude feature still works: projects, artifacts, connectors, Canva, design systems.

## Two ways to run it

### 1. Mac app (recommended)

Claude sits inside the app, next to your folders.

**First install (about 15 minutes, once)**

1. **Install Node.js.** Go to nodejs.org, download the **LTS** version for macOS, and run the installer.
2. **Install GitHub Desktop** from desktop.github.com and sign in with your GitHub account.
3. **Get the code.** In GitHub Desktop choose File, Clone Repository, pick `General-Internal`, and click Clone. Then use the Current Branch menu at the top to switch to the branch that holds the app.
4. **Install the app.** In GitHub Desktop choose Repository, Show in Finder. Open the `claude-navigator` folder and double-click **Install or Update.command**. A Terminal window builds the app (a few minutes the first time), puts it in Applications and opens it.
   - If macOS says the file cannot be opened, right-click it, choose Open, then Open again.
5. **Sign in to Claude** in the right-hand pane. If Google sign-in will not work there, use "Continue with email". You stay signed in from then on.

Claude Navigator is now in Applications, Launchpad and Spotlight. Right-click its Dock icon and choose Options, Keep in Dock.

**Updating to a new version**

1. In GitHub Desktop, click Fetch origin, then Pull origin.
2. Double-click **Install or Update.command** again.

Your folders and Claude sign-in are kept. They live in `~/Library/Application Support/Claude Navigator`, separate from the app. For extra safety, use the ... menu, "Back Up Folders to a File", before updating.

macOS may ask again for microphone permission after an update, because each build counts as a new app until it is signed with an Apple developer certificate.

**For developers:** `npm start` runs it straight from the folder, and `npm run build:mac` makes installer disk images in `dist`.

**Sign-in tip:** if Google sign-in refuses to work inside the app, use "Continue with email" instead. Claude emails you a code.

(Windows: install Node.js, run `npm install`, then `npm run build:win`.)

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

**Inside Claude**

- **Right-click** works as in Safari: copy, paste, spelling suggestions, open a link in a new window or your browser, copy an image, and "Save Link to a Folder" for any link in a chat.
- **Find on page**: ⌘F opens a find bar while Claude is showing (⌘G and ⌘⇧G for next and previous). In a folder, ⌘F searches your folders instead.
- **Downloads** from Claude (artifacts, exports, images) go straight to your Downloads folder, with a "Show in Finder" button.
- **Print or save a chat as a PDF** with ⌘P.
- **Voice mode**: macOS asks once for microphone permission.
- **Names stay current**: a saved chat takes Claude's title for it, and follows if you rename the chat in Claude. If you rename it yourself in your folders, your name sticks.

On Windows the same shortcuts use Ctrl, F2 renames and Enter opens.

## Your data

Folders are stored on your computer only, inside the app. Use the `...` menu, "Back up folders to a file", to save a copy. "Restore folders from a file" brings it back, including on another computer.

## Files

- `index.html`: the whole interface (tree, menus, dialogs). Edit this to change how it looks and behaves.
- `main.js`: the desktop app window and the Claude pane.
- `preload.js`: the small bridge between the two.

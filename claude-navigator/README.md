# Claude Navigator

Your own front end for Claude, laid out like the Mac Finder: a sidebar of folders on the left, and a main window that shows either a folder's contents (as icons or a list) or Claude itself.

Folders can nest as deep as you like. Each link points at a Claude chat, project, artifact, or any other page (Canva designs, Google Docs). Clicking a link opens it in Claude, signed in as you, so every Claude feature still works: projects, artifacts, connectors, Canva, design systems.

## Trying changes straight away (Live Preview)

To see a change from Claude within seconds instead of waiting for a release:

1. Quit Claude Navigator.
2. In the `claude-navigator` folder, double-click **Live Preview.command**. It runs the app straight from the code, with your usual folders and Claude sign-in, and an orange **Live preview** badge in the top bar.
3. Leave it running. It checks GitHub for new changes every 20 seconds and refreshes itself when they arrive (the window reloads; bigger changes restart the app).

If your Mac cannot fetch from GitHub on its own (the badge's tooltip tells you), click **Fetch origin** then **Pull origin** in GitHub Desktop when Claude says a change is ready: the app refreshes the moment the files change. GitHub Desktop must be on the branch Claude is working on.

When you are happy with the changes, Claude publishes a signed release and your installed app updates itself. Close the Terminal window to stop the preview, then open the app from Applications as usual.

## Updates

Signed versions update themselves: the app checks for a new version on start-up and every few hours, downloads it quietly, and tells you when it is ready ("Restart Now"). It also installs next time you quit. **… › Check for Updates…** checks straight away. Setting this up (an Apple Developer account and a few GitHub settings, done once) is explained step by step in [RELEASING.md](RELEASING.md).

Copies built on your Mac with **Install or Update.command** do not update themselves; run the script again to update them.

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

## New chats, docs, slides, designs, dashboards and projects go straight into a folder

Click the + button at the top, or right-click a folder (or empty space inside one), and choose what to make. Right-click menus show **New Chat** and **New Folder** first, and everything else under **New ▸**: **Doc, Slides, Design, Dashboard, Project, Artifact in a Chat**, and Word, Excel, PowerPoint and text files. ⌘N starts a new chat in the folder you are in.

- **Chat**: saved in the folder as soon as you send your first message.
- **Doc, Slides, Design, Dashboard**: the app opens Claude's "Make something new" and picks the right tile for you. Whatever Claude creates is saved in the folder, with a matching icon, even if Claude opens it in a separate window.
- **Project**: the app opens Claude's Create Project box. Name it, click Create Project, and it is saved in the folder.
- **Artifact in a Chat**: starts a chat for you to ask Claude for an artifact; the chat is saved with an artifact icon.

While it waits, the top bar shows "Saves in Board once created". Click the ✕ on that tag if you do not want it in a folder.

**Made something with Claude's own buttons?** If you start a new chat with Claude's own button while you are working in a folder, it is set to save in that folder too (with the same ✕ to cancel). If you make a Doc, Slides, Design or Dashboard from Claude's own menus, the app offers a one-click "Save in Board" instead of filing it without asking.

**Always know where you are.** While Claude is open, the top bar shows the folder path, for example Work › Monkey Baa › Board › Budget questions. Click any part to go there. The sidebar highlights that folder and the chat inside it. A chat that is not in any folder shows "Not in a folder"; press ⌘S to save it.

**Claude's own sidebar is hidden** so your folders are the only navigation. Claude's own button still opens it when you need it. To keep it showing, untick "Hide Claude's Own Sidebar" in the ... menu at the bottom of the sidebar.

## The Claude section

In a profile, the Claude lists show only what is filed in that profile, plus anything not filed anywhere yet; things filed only in another profile are left out. All Profiles shows everything. The numbers beside the lists count what is not filed in any profile.: file your existing chats

At the top of the sidebar, the **Claude** section has **New Chat** and lists everything in your Claude account: **Recent Chats**, **Projects** and **Artifacts**. The number beside each shows how many are not in one of your folders yet.

- Click Recent Chats to see every chat, newest first, with a column showing which folder it is filed in.
- Drag a chat onto any folder in the sidebar to file it. Select several first with ⌘-click, or ⇧-click for a range, and drag them together.
- Or right-click and choose File in Folder.
- Choose **Filter, Not in a Folder** to see only what is left, like an inbox.
- Double-click to open it in Claude.
- The list refreshes when you open it (at most every five minutes), every ten minutes in the background, and when you click Refresh.

How it works: Claude has no official way for other apps to read your chat list, so the app asks claude.ai for it the same way Claude's own Recents page does, using your signed-in session. If Anthropic changes that, the app falls back to reading the Recents and Artifacts pages directly. If the list ever comes up empty, click Refresh, and tell Claude Code what the message at the bottom says.

## Saving anything to a folder

Once a page is saved, the Save button says **Saved**; click it (or the small arrow beside it) for **Save a Copy As…**, **Move to Another Folder…**, **Show in Folder** and **Remove from Folder**.

When a chat, artifact or anything else is open and not yet in a folder, the top bar says **Not in a folder**. Click it, press ⌘S, or use **Save As…** (⇧⌘S, or right-click the Save button) to choose where it goes. Every "where" box in the app is a small folder browser, like the Mac Save dialog: open folders with their arrows (or double-click), pick one, or click **New Folder** to make one on the spot.

## Systems: Claude and monday.com

The top of the sidebar is **Systems**: the places your folders draw from. **Claude** and **monday.com** each start closed; click one to open it (the app remembers).

### monday.com

1. Open **monday.com** under Systems and click **Connect monday.com…**.
2. In monday.com, click your profile picture, then **Developers › My access tokens**, then **Show** and **Copy**.
3. Paste the token into the box and click **Connect**.

The token is stored encrypted in your Mac's Keychain and only ever sent to monday.com. Under monday.com you then have, like Claude's section:

- **All Workspaces**: opens in the main window. Double-click a workspace, then its folders, to reach the boards (each marked with monday.com's red, yellow and green mark). The path bar and Back/Forward take you back up.
- **Open a board** (double-click) to use it on the right, inside the app (sign in to monday.com there once).
- **Drag boards** from the list into any of your folders to file them, next to your Claude chats and files.
- **New Board**: makes a board in monday.com, in the workspace and folder you are looking at (or ones you pick), and opens it. From one of your own folders, **New ▸ New monday.com Board** also files it there.
- Right-click monday.com for **Refresh**, **Change API Token…** or **Disconnect**. The list also refreshes by itself every so often.

Deleting a board from your folders only removes it from the folder; nothing is changed in monday.com.

## Split view

Click **Split** in the toolbar (it works in any list: All Chats, Artifacts, monday.com, your folders). Your own folders appear on the left; whatever you are browsing stays on the right.

- The left side has its own path and back button: double-click a folder there to go into it.
- Drag items from the right onto a folder on the left to file them there, or into the empty space to file them in the folder shown.
- Neither side loses its place while you file, so you can work through a list quickly. Click **Split** again to close it.

## Search

The search box looks through all your folders (names and addresses), or through the Claude list you are viewing. Capitals never matter.

| Type | Finds |
|---|---|
| `cape town` | both words, in any order |
| `"cape town"` | exactly that phrase |
| `zanzibar OR safari` | either one (`|` works too) |
| `board -minutes` | "board" but not "minutes" (also `-"exact phrase"`) |

## One Rename, one Delete

Right-click anything in your folders:

- **Rename**: a chat is renamed here and in Claude. Artifacts and your own files are renamed here (Claude does not let other apps rename artifacts).
- **Delete…**: a chat is deleted in Claude for good and removed from your folders (it asks first; this cannot be undone). Your own files (Word, Excel, PDF…) go to the Trash. Artifacts are removed here, with a button to open them in Claude to delete them there. Deleting a folder never deletes the chats inside it from Claude.
- **Duplicate** (folders and files): makes a real copy, including the files on your Mac. Chats and artifacts have no Duplicate, because Claude cannot copy them.

## Your folders on your Mac

Safety: only what you delete in the app ever goes to the Trash. Undo, restoring a backup and Reset never send anything there. If your folder cannot be found or read (moved, renamed, an unplugged drive, or macOS not allowing access to Documents), the app tells you and changes nothing until it is back. **Change Folder Location…** moves your folders and files to the new place (choose an empty folder).

Turn on **Keep Folders on This Mac** (the app offers it once, and it is in the ... menu) and your profiles and folders become real folders in **Documents › Claude Navigator**: one folder per profile, with your folders inside.

- **Claude items** (chats, artifacts, projects, links) are small link files there (".webloc" on a Mac). In the app they open in Claude; double-clicked in Finder they open in your browser.
- **Your own files** (Word, Excel, PowerPoint, PDF, images, anything) can live in the same folders. They show in the app with their own icons and open in their own apps.
- **New files**: the + menu and right-click menus have **New Word Document**, **New Excel Spreadsheet**, **New PowerPoint Presentation** and **New Text File**. Give it a name and a folder; it is created there and opens in its app.
- **Both ways**: what you do in the app (new folder, rename, move, delete) happens on disk, and what you do in Finder (add files, rename, move, delete) shows up in the app within a second or two.
- **Drag files in** from a Finder window or the desktop onto any folder in the sidebar, or into the open folder's list, to copy them there. If folders on your Mac are not switched on yet, the app offers **Turn On and Add Files**.
- **Deleting** in the app moves things to the Mac Trash, so you can always get them back from there.
- Right-click anything and choose **Show in Finder**. **Change Folder Location…** in the ... menu moves your folders somewhere else.

## Customise the toolbar

Right-click the toolbar at the top (anywhere except the search box):

- **Remove “…” from Toolbar** takes off the item you clicked.
- **Show or Hide Items…** lists every item with a tick, so you can put things back or take them off.
- **Customise Toolbar…** opens a panel under the toolbar. Drag items along the toolbar to move them, drag them down into the panel to take them off, or drag them from the panel up into the toolbar to add them. **Flexible Space** pushes things apart (put one on each side of a button to centre it); **Space** is a small fixed gap. Right-click an item for Move Left and Move Right. Press **Done** or Esc when finished.
- **Restore Default Toolbar** puts it back the way it came.

Items that only appear in some places (such as Save on a Claude page, or Refresh in the Claude lists) still only appear there, in the position you chose. Your layout is kept between sessions.

## Profiles

Your folders live in **profiles**, for example Monkey Baa, NCTI and Personal. The switcher at the top of the sidebar picks one:

- **One profile**: you see only its folders, and new chats, Save As, search and the folder browser all stay inside it. Its colour tints the sidebar and top bar, draws a line across the top, and becomes the highlight colour, so you always know where you are.
- **All Profiles**: every profile as a top-level group with everything inside. Drag things between profiles here.
- **New Profile…** and **Edit Profile…** in the switcher: a name, a colour (the Monkey Baa palette or any colour), and how strong the tint is (Subtle, Medium, Bold). Edit also lets you delete a profile.
- ⌥⌘1, ⌥⌘2 … switch straight to a profile; ⌥⌘0 is All Profiles.
- **Change the order**: in All Profiles, drag a profile above or below another. Or right-click a profile for **Move Profile Up / Down**, **Move to Top / Bottom**, or use **Change Profile Order…** in the switcher. The order is used everywhere, including the ⌥⌘ number shortcuts.

Each profile ends with an **Other** group holding **Code**, **Design Systems** and **Schedules** folders.

The first time you open this version, your old layout is converted once: Work › Monkey Baa and Work › NCTI become profiles, Personal becomes a profile, and the old App Code (now Code), Design Systems and Schedules groups move into Monkey Baa's Other group with everything in them. Nothing is deleted.

## The Claude section

**New Chat**, **All Chats** and **Artifacts**, then **Other** (closed until you open it) with **Design Systems**, **Code** and **Scheduled**. The numbers show what is not in a folder yet.

**All Chats** shows chats and artifacts together: each chat's artifacts under it (click the arrow beside a chat to hide or show them), then the artifacts not linked to any chat at the end. Drag one of those onto its chat to link them. The Artifacts button at the top shows or hides them.

Items get the right icon where Claude says what they are, or where the name makes it clear (for example "… Design System" or "… Slides"). Right-click anything and choose **Change Icon…** to correct it.

## Managing your chats

**All Chats** is a full list of every chat in your Claude account, 100 per page (Previous and Next at the bottom right).

- **Search**: type in the search box at the top right.
- **Filter** (top bar): everything, not in a folder, in a folder, or archived; any time, today, last 7 days, last 30 days, or older; with or without artifacts; starred only. "Filter (2)" means two filters are on; Reset Filters clears them.
- **Select** (top bar): adds checkboxes, with a box in the Name heading that selects everything that matches, across all pages. The bar above the list then offers **File in Folder**, **Archive**, **Delete from Claude** and **Clear Selection**. ⌘-click, ⇧-click and right-click work too.
- **Rename…** (right-click a chat) renames it in Claude too. Copies of the chat in your folders take the new name, unless you gave a copy your own name.
- **Delete from Claude** deletes the chats from your Claude account for good (the same as deleting them in Claude), and removes them from your folders here. It always asks first, and twice for more than 10. It cannot be undone.
- **Archive** hides chats from the list in this app only; Claude has no archive to sync with, so nothing changes there. See them with Filter, Archived, and Unarchive them from there.
- Artifacts can't be deleted from here yet; right-click one and choose **Open in Claude to Delete**.

## The same tools in every list

Folders, search results and the Claude section all have the same tools in the top bar:

- **Filter**: in folders, by kind (folders, chats, artifacts, code, projects, other links), by date, or archived only. In the Claude lists, also filed or not filed, with or without artifacts, and starred.
- **Select**: checkboxes on every row (and on icons in icon view), with a box in the Name heading that selects everything that matches, across all pages. In folders the bar offers **Move To**, **New Folder with Items**, **Archive**, **Copy Links**, and **Delete**.
- **Pages** of 100, with Previous and Next at the bottom right.
- **Narrow windows**: columns that do not fit drop out (Name always stays), and the top-bar buttons shrink to icons; hover for their names.

Archived items are hidden everywhere, including the sidebar, until you choose Filter, Archived (only in this app; Claude is not changed).

## Artifacts stay with the chat they came from

An artifact made in a chat sits underneath that chat (with a small ↳ arrow), in the sidebar and in list view. Click the arrow beside the chat to hide or show its artifacts. The **Artifacts** button in the toolbar switches all attached artifacts on or off at once, in your folders and in All Chats. **Expand All / Collapse All** in the top bar does it for every chat in the list (it appears when the list has chats with artifacts under them). When you file a chat (for example by dragging it from All Chats into a folder), every artifact Claude made in that chat comes with it, unless you have already filed that artifact somewhere else. If you take an artifact out from under its chat, it stays out. They move together: drag either one and both go.

- **Detach** an artifact (right-click, Detach from Chat) to move it on its own, for example when one chat made several artifacts that belong in different places. ⌥-drag also moves it on its own.
- **Attach** it again by dropping it onto the chat, or right-click and choose Attach to Chat.
- The app learns these links by itself, in the background: from chats that mention an artifact's ID or its full name (a name mentioned by several chats is ignored rather than guessed), from an artifact's own page linking back to its chat, and when you open an artifact from a chat in the app. Where an artifact and its chat sit in the same folder, the artifact moves under the chat automatically (with Undo). A detached artifact is never reattached automatically. If links are not appearing, choose **Copy Link Diagnostics** in the ... menu and paste the result to Claude Code.
- The app learns these links when you open an artifact from a chat. Filing that chat then brings its artifacts along, and an artifact filed into the folder that holds its chat goes under the chat.
- In **Recent Chats**, the **Attached** button at the top shows or hides each chat's artifacts underneath it.

## Your Claude account

Claude's own sidebar is hidden, so its account menu lives in the person button at the bottom of the sidebar: Settings, Usage, Language, Help, Upgrade, Apps, API keys and Log out.

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
| Expand or collapse everything inside a folder | Hover over it in the sidebar and click the small double arrow, or ⌥-click its arrow, or ⌥→ and ⌥← |
| Choose list columns | Right-click the column headings. Options include Last Edited, Date Added, Last Opened, Items, Where, In Folder and Address |
| Resize a column | Drag the thin line between headings. Double-click the line to reset it |
| Sort a list | Click a column heading; click again to reverse. Folders stay on top. Right-click the headings and choose Sort by Your Own Order to go back. Sorting never changes your own arrangement |
| See what a button does | Hover over it. Tooltips name every button and icon, with its shortcut |
| New folder | ⌘⇧N (in the folder you are looking at), or New Folder at the bottom of the sidebar |
| Save the Claude page you are looking at | ⌘S |
| Rename | Select it, press Return (like Finder) |
| Remove or delete | ⌘⌫. Chats and artifacts are only **removed** from the folder (they stay in Claude); folders and your own files are **deleted** (files go to the Trash). Undo with ⌘Z or the Undo button |
| Move things | Drag onto any folder, in the sidebar or the main window. Drag between sidebar rows to reorder |
| Save a link from your browser | Drag it from the address bar onto a folder |
| Find anything | ⌘F, then type. Results show which folder each item is in |
| Select several | ⌘-click to add or remove, ⇧-click for a range, ⌘A for everything in the folder, ⇧↑ ⇧↓ to extend. Works in the main window and the sidebar |
| Act on several | Drag them together onto a folder, or right-click for New Folder with Items, Move To, Copy Links and Remove (or Delete when folders or files are included). ⌘⌫ does the same |
| Open in a separate window | Middle-click, or right-click and choose Open in New Window |
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

Folders are stored on your computer only, inside the app.

- **Automatic backups**: once a day the app saves a copy of your folders (and which artifacts belong to which chats). The last 30 days are kept. To go back, use the `...` menu, **Restore from Automatic Backup…**, and pick a day. **Back Up Now** makes one straight away.
- **Back Up Folders to a File** saves a copy anywhere you like; **Restore Folders from a File** brings it back, including on another computer.
- Restoring never touches the folders and files on your Mac: anything there that is not in the backup simply shows up again.
- If the app ever cannot read its saved folders, it keeps them aside (never overwrites them), shows the example folders, and tells you to restore a backup.

## Chats deleted in Claude

When a chat you filed is deleted in Claude itself (on the website or another device), it stays in your folder, crossed out, with a **Deleted in Claude** label, so nothing disappears without you knowing. Remove it with right-click, **Delete…**, or remove them all at once from the `...` menu, **Remove … Chats Deleted in Claude…**. Artifacts attached to them stay in the folder.

## Files

- `index.html`: the whole interface (tree, menus, dialogs). Edit this to change how it looks and behaves.
- `main.js`: the desktop app window and the Claude pane.
- `preload.js`: the small bridge between the two.

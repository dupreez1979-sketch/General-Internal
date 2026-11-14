# Claude Navigator: plan for the remaining gaps

Ordered by value for effort. Sizes are rough: small is an hour or two, medium is half a day to a day, large is several days.

## Step 0. Try it on your Mac (you, 15 minutes)

Before building more, run `npm start` and use it for a few days of normal work. Note anything that looks off or gets in the way. This decides the order below.

## Step 1. Quick-open shortcut from anywhere (small)

Press ⌥Space in any app and Claude Navigator comes to the front with a new chat ready, filed into the last folder you used. Replaces the quick-entry shortcut of the official Claude desktop app. You choose the key combination.

## Step 2. Dead link check (small)

When you open a saved chat that Claude has deleted, Claude sends you to a blank new chat. The app will spot this, mark the link with a warning sign, and offer to remove it. A "Check all links" option in the ... menu will test every saved chat quietly in the background.

## Step 3. Tabs (medium)

A tab strip above the Claude pane, like Safari. ⌘T new tab, ⌘W close, ⌘⇧[ and ⌘⇧] to switch. Open a link with ⌘-click to get a new tab. Open tabs come back when you restart. Drag a tab onto a folder to save it.
Trade-off: each tab is a full copy of Claude in memory, so the app will suggest closing tabs past about eight.

## Step 4. Folders on all your Macs (medium)

Keep the folders file in iCloud Drive (a "Claude Navigator" folder) instead of inside the app. Every Mac signed in to your iCloud sees the same folders, and changes made on one appear on the others within a minute. If two Macs change the folders at the same moment, both sets of changes are kept.
Phone and web access is a separate, larger step (Step 7).

## Step 5. One navigation instead of two (medium, some risk)

Optional "Focus mode" that hides Claude's own left sidebar (Recents, Projects, Starred) so your folders are the only navigation. Turn it off at any time.
Risk: this relies on how Claude's page is built today. When Anthropic changes Claude's layout, focus mode may stop hiding the sidebar until the app is updated. It can never break Claude itself, only fail to hide things.
Optional extra: "File these chats" on Claude's Recents page, to tick several chats and drop them into a folder in one go. Same risk applies.

## Step 6. Proper Mac app signing (medium, needs an Apple Developer account)

The Apple Developer Program costs about A$149 a year. With it, the app is signed and notarised, so macOS opens it without the security warnings, and the app can update itself when a new version is published.
Without it, everything still works. You just approve it once in Privacy & Security, and update by rebuilding.

## Step 7. Folders on your phone and the web (large)

Store the folders online (for example in your Supabase account, which is already connected) behind your own sign-in. The browser version of index.html then shows the same folders on any device, including an iPhone home-screen shortcut. Links still open in the Claude app or claude.ai.
Only worth doing if you find yourself wanting your folders away from your Macs.

## Things that will stay different

- **Desktop extensions and local connectors** (Claude reaching files and apps on your Mac) belong to Anthropic's own Claude desktop app. This app shows claude.ai, so it cannot run them. Keep the official app installed for those tasks. A "Open in Claude app" option can be added if the official app accepts links.
- **Google sign-in** may stay blocked inside the app. Signing in with an email code works and only needs doing once.
- **Browser extensions** (password managers, Grammarly) do not run inside the app. Electron can load some Chrome extensions, but support is patchy, so this is not planned.

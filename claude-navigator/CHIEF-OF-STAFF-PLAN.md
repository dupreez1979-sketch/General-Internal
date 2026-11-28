# Chief of Staff: plan

A second app inside Claude Navigator. Navigator organises *things* (chats, artifacts, boards, files). Chief of Staff organises *who does what*: a team of staff, led by a Chief of Staff, each with their projects, actions, functions and routines, all built from the same things Navigator already knows about.

## 1. Switching apps

- A nine-dot button at the top of the sidebar (like monday.com's) opens a small panel: **Navigator** and **Chief of Staff**, with room for more apps later.
- Each app keeps its own place: switching back returns you to where you were.
- Both apps share the profile switcher, the Systems (Claude, monday.com), split view, search and drag and drop.

## 2. The team (org chart)

- Each **profile** has its own team (Monkey Baa's team is separate from NCTI's).
- At the top: the **Chief of Staff**. Below: **staff** and **departments**, as deep as needed.
- A **department** is a group with an optional **leader**; staff sit in a department or report directly to someone.
- Each staff member has: name, role or function, a short description, a colour or photo, and who they report to.
- **Org chart view**: a visual diagram (boxes and lines), zoom and fit to screen. Click a person to open their page; drag a person onto another to change who they report to; right-click to add staff below, add a department, edit or remove.
- **List view** of the same team for quick editing and search.

## 3. A staff member's page

Four tabs:

| Tab | What it is | Built from |
|---|---|---|
| **Projects** | What they are working on. Each project is a collection with its own little folder tree. Projects can be archived (kept, hidden) or deleted. | Chats, artifacts, monday.com boards, files, folders: dragged in from Claude, monday.com, your folders or Finder |
| **Actions** | One-off jobs: "do this now". Status (to do, doing, done), optional due date, optional link to the chat where it is being done. | A chat, or nothing yet |
| **Functions** | What they know how to do well and do on request: board papers, chart-of-accounts audit. Each has a **Run** button. | An existing Claude chat, project or skill you attach |
| **Routines** | Things they do on a schedule, shown visually: what it does, when it runs, when it last ran, what it produced. | Claude scheduled tasks |

- Projects behave like your folders: same list, icon view, filters, drag and drop, split view (team member's project on the left, Claude or monday.com on the right).
- An item can be in a project *and* in your Navigator folders at the same time (links, not copies), the same way a chat can be in two folders today.

## 4. Routines and Claude schedules

- Routines link to Claude's scheduled tasks (the Scheduled list Navigator already reads).
- Each routine shows as a card: name, plain-English schedule ("Every Monday 8:30 am"), next run, last run and its result, and the chat or output it produced.
- A **Week view** across the whole team: a simple timeline of who runs what, when.
- Version one: link existing schedules and describe when they run. Later: read the schedule details from Claude automatically, if Claude makes them readable. Creating a new schedule opens Claude's own scheduling page and links the result back.

## 5. Look and feel per profile

- Chief of Staff takes the look of the profile's design system (set in Edit Profile).
- Version one: the profile's colours and the standard Navigator look, so it already changes by profile.
- Next: read the design system's colours, fonts and corner style from its Claude page and apply them to the Chief of Staff pages. Profiles without a design system use the standard look.

## 6. Where the data lives

- Stored with your folders (same safety rules: automatic daily backups, undo, nothing deleted without asking).
- Later, optionally mirrored to Documents › Claude Navigator › *Profile* › Chief of Staff, so projects are real folders too.

## 7. Phases

| Phase | Delivers | Size |
|---|---|---|
| 1. Shell and team | App switcher; Chief of Staff home; staff, departments and leaders; org chart and list views; per profile; profile colours | Large |
| 2. Projects | Staff page; projects with folder trees; drag and drop from Claude, monday.com, folders and Finder; archive and delete; split view | Large |
| 3. Actions and functions | Actions with status and due dates; functions linked to chats or skills with Run | Medium |
| 4. Routines | Routine cards linked to Claude schedules; week timeline; create via Claude's scheduling page | Medium |
| 5. Design-system look | Read colours and fonts from the profile's Claude design system and apply them | Medium, depends on what Claude's page exposes |
| 6. Polish | Disk mirroring, keyboard shortcuts, search across the whole team, export the org chart | Medium |

Each phase is tried in Live Preview before it goes into a release.

## 8. Decisions (settled)

1. Staff are **AI staff**, not real people.
2. **One team per profile.**
3. Routines: **both** link existing Claude schedules and start new ones from here.
4. Design-system look: **colours and fonts** are enough.
5. App switcher: a nine-dot panel (Claude's call).

## 9. Progress

- Phase 1 (shell and team): **done**. App switcher, one team per profile, Chief of Staff at the top, staff and departments with leaders, org chart and list views, editing panel, drag to restructure, undo, backups.
- Phase 2 (staff pages and projects): **done**. Staff pages with tabs; projects with their own folders; Add Items shows Navigator's Claude, monday.com and folder lists beside the project for dragging in; archive and delete projects.
- Phase 3 (actions and functions): **done**. Actions with status, due dates (overdue highlighted) and a linked chat; functions with description, instructions for Claude, a linked chat/project/artifact and Run (opens it with the instructions copied).
- Phase 4 (routines): **done**. Routine cards with a plain-English schedule, next run, linked Claude scheduled task and results chat; pause; a week strip on each staff page and a team-wide Week view; New Schedule in Claude opens Claude's Scheduled page.
- Phase 5 (design-system look): **done**. Colours (named where the page names them) and fonts read from the design system's Claude page; chosen in Edit Profile's Look section; applied to Chief of Staff only; font files saved locally. Tested against a mock page; first real check is a live design system.
- Profile look now also applies to Navigator (both apps share it).
- Phase 6 (polish): **done**. Team-wide search; keyboard shortcuts; org chart export as PDF or image; one-way mirror to Documents › Claude Navigator Chief of Staff (only touches what it made, removals go to the Trash).

## 10. Simpler model (after the review)

- Each staff member's **Work** is a Navigator folder (Team › name › project folders), shown with Navigator's own list, toolbar, menus, split view and keys; items are actions with a Done tick. This replaced the separate Projects and Actions tabs and the Documents mirror (the folders are already kept on disk).
- Each staff member can have a **Claude Project**; their new chats (Work, Skills, Ask) start in it.
- **Skills** replaced Functions (no forms). **Routines** are read-only from Claude; a task missing in Claude is flagged and you decide.
- **Ask** opens a chat with a brief of where the person (or the whole team) is up to.
- Fixes from the review: stricter "deleted in Claude" check that asks before removing; ⌘Z/⌘N act on Chief of Staff; half-made items never link after switching app or profile; background updates no longer wipe typing; routines never link an existing task or the same task twice.


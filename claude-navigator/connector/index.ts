// The Chief of Staff app's Claude connector (a small relay).
//
// Claude, in a chat on claude.ai, calls the one tool here to hand over what it proposes: emails to open, meetings to
// open, and changes to the calendar or mail. This function does nothing with them except seal them with the app's
// public key and hold them until the app on the Mac collects them, a few seconds later. It cannot read them back (only
// the Mac holds the private key), it has no access to any mailbox or calendar, and it can change nothing anywhere.
// The app shows what arrives on an approval card; nothing happens until it is approved there.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!, KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = (path: string, init: RequestInit = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) } });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const b64 = (u: Uint8Array) => { let s = ""; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const sha = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map(x => x.toString(16).padStart(2, "0")).join("");
const okHash = (h: unknown) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h);

// Sealed so that only the Mac can open it: a one-off key pair, a shared secret with the app's public key, AES-GCM.
async function seal(pubB64: string, text: string) {
  const pub = await crypto.subtle.importKey("raw", unb64(pubB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, eph.privateKey, 256));
  const mix = new Uint8Array(shared.length + ephRaw.length); mix.set(shared); mix.set(ephRaw, shared.length);
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", mix), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  return JSON.stringify({ v: 1, e: b64(ephRaw), i: b64(iv), c: b64(ct) });
}

const CHANGE_HELP = `Each change is an object with "do" and its own fields:
- "add_event": title, start and end as "YYYY-MM-DDTHH:MM" in his local time (or all_day true with start and end as "YYYY-MM-DD"), where, notes, remind_minutes, show_as ("free", "busy", "tentative" or "away"), time_zone. Give times as they are on the clock where the thing happens, and when that is not his home time zone give time_zone as an IANA name (for example "Australia/Brisbane" for Cairns): do not convert the times yourself. Nobody is invited: put names in the notes.
- "remove_event": find (the title of the entry exactly as it shows in his calendar), date ("YYYY-MM-DD", the day it is on).
- "change_event": find and date as above, then whichever of title, start, end, where, notes are to change.
- "add_rule": name, and any of from, subject_has, message_has, sent_to (each a list), has_attachment; then move_to (a mail folder name), mark_read, delete.
- "add_folder": name, inside (a folder name, optional).
Never give ids of calendar entries or emails: the app has its own. Name the entry and its day.`;
const TOOLS = [{
  name: "show_for_approval",
  title: "Show in the Chief of Staff app for approval",
  description: "Hand emails, meetings, calendar or mail changes, actions for his staff and documents to the user's Chief of Staff app on his Mac, where they appear for him to check and approve. Use this whenever he asks you to put something in his calendar, set up or change calendar entries, draft or send an email, set up a meeting or invitation, make a mail rule or folder, add an action or to-do for a staff member, or save something as a document. Prefer this over any other calendar or email tool for making or changing things. Nothing is sent, created or changed by this call: he approves each item in the app, and he sends every email and invitation himself. Put everything from one request into a single call. Never use em dashes in the text you write.",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One short line saying what this is, shown as the heading." },
      for_account: { type: "string", description: "Which of his organisations or email accounts this belongs to, in his own words or as an email address (for example \"Monkey Baa\" or \"Consulting\"), when the chat makes it clear. Leave out if unsure." },
      emails: { type: "array", description: "Emails for him to check and send himself. No signature (his mail app adds it).", items: { type: "object", properties: { to: { type: "string", description: "Addresses or names, separated by commas" }, cc: { type: "string" }, subject: { type: "string" }, body: { type: "string", description: "Plain text, blank lines between paragraphs. For a reply, only the new words: the app adds the earlier emails underneath." }, reply_to: { type: "object", description: "Give this whenever the email answers one he received, so it opens as a reply in that conversation with the history underneath. Describe the email being answered.", properties: { subject: { type: "string", description: "Its subject, exactly" }, from: { type: "string", description: "Who sent it: name or address" }, sent: { type: "string", description: "When it was sent, YYYY-MM-DD, if known" } }, required: ["subject"] }, reply_all: { type: "boolean", description: "true to answer everyone on the email, false for the sender only" }, attach: { type: "array", description: "Files to attach. Each is the path of a file that is already saved on his Mac inside his company folders: the full path, or the path from the top folder (for example \"NCTI/Team/Finance Officer/Budget summary.pdf\"), exactly as it was saved. A file that exists only in this chat cannot be attached: save it into his folder first, then name it here. If you cannot save it there, leave this out and tell him the file is not attached.", items: { type: "string" } } }, required: ["subject", "body"] } },
      meetings: { type: "array", description: "Meetings with other people. Each opens as an invitation for him to check and save; nobody is told until he does.", items: { type: "object", properties: { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, start: { type: "string", description: "HH:MM, 24 hour, his local time" }, end: { type: "string", description: "HH:MM" }, where: { type: "string" }, teams: { type: "boolean", description: "true if online" }, invite: { type: "string", description: "Email addresses when known for certain, otherwise names exactly, separated by semicolons. Never guess an address." }, purpose: { type: "string" }, agenda: { type: "string", description: "Items separated by semicolons, minutes in brackets if said" }, before: { type: "string", description: "What to read or bring, separated by semicolons" }, notes: { type: "string" }, check: { type: "string", description: "Anything you assumed, shown only to him" } }, required: ["title"] } },
      actions: { type: "array", description: "Actions (to-dos) to add to the list of one of his staff members in the app.", items: { type: "object", properties: { for: { type: "string", description: "The staff member's title, for example \"Finance Officer\". Leave out if unsure and he chooses." }, action: { type: "string", description: "The action in one short line, starting with a verb" }, why: { type: "string", description: "One line of background" } }, required: ["action"] } },
      documents: { type: "array", description: "Documents to save as Word files in one of his company folders (he chooses the folder).", items: { type: "object", properties: { title: { type: "string" }, text: { type: "string", description: "The whole text, plain, with a blank line between paragraphs" } }, required: ["title", "text"] } },
      changes: { type: "array", description: "Entries in his own calendar with nobody invited, and mail rules and folders. " + CHANGE_HELP, items: { type: "object", properties: { do: { type: "string", enum: ["add_event", "remove_event", "change_event", "add_rule", "add_folder"] } }, required: ["do"], additionalProperties: true } },
    },
    required: ["summary"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, {
  name: "check_outcome",
  title: "See what he did with what you handed over",
  description: "Find out what the user did in his Chief of Staff app with things you handed over using show_for_approval: for each email, meeting, change, action and document, whether it is still waiting, was opened, done, dismissed or failed. Use it before you say that anything was sent, booked, added or changed, and when he asks what happened. It tells you only the state of each item, in the order you gave them. An email or meeting that was opened is with him to check and send: you cannot know whether he sent it.",
  inputSchema: { type: "object", properties: { ref: { type: "string", description: "The reference show_for_approval gave you. Leave out for the most recent hand-overs." } } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, {
  name: "act_on_item",
  title: "Open or dismiss one item in his app",
  description: "Open one item you handed over in the user's Chief of Staff app (an email or meeting opens for him to check; nothing is sent), or take it off his list. This is what the buttons in the panel do. Call it yourself only when he asks you to open or dismiss a particular item. Never dismiss anything he did not ask you to.",
  inputSchema: { type: "object", properties: { ref: { type: "string", description: "The reference show_for_approval gave" }, kind: { type: "string", enum: ["emails", "meetings", "changes", "actions", "documents", "handover"] }, index: { type: "integer", description: "Which one of that kind, counting from 0 in the order you gave them (0 for handover)" }, do: { type: "string", enum: ["open", "dismiss", "amend"] }, set: { type: "object", description: "Only with amend: the fields to change before he opens it. Email: to, cc, subject. Meeting: title, date, start, end, invite, where. Action: for, action. Handover: for_account." } }, required: ["ref", "kind", "index", "do"] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];
// Small questions his Mac answers, so that Claude need not be given his mail or calendar to find one fact. Each
// answer is the least that settles the question, it comes from the app on his Mac, and it is not kept here.
// Saving a finished design to his Design Studio. Only ever at his word: nothing is gathered there by itself.
const DESIGN_TYPES = ["Presentation", "Proposal", "Document", "Report", "Video", "Social", "Email", "Invitation", "Brand", "Web page", "Other"];
const DESIGN_TOOL = {
  name: "save_design",
  title: "Save a design to his Design Studio",
  description: "Save a finished design (a presentation, proposal, document, video, artifact or file made in this chat) to the Design Studio in the user's Chief of Staff app. Call this ONLY when he asks for it in words like 'save this to the Design Studio' or 'add this to my designs'. Never call it by yourself, and never for ordinary answers or drafts: the Design Studio holds only what he chose to keep. He confirms the name, type, staff member and folder in a short form. Give the design's exact title as it appears in this chat (the artifact's title, or the file's name) so his app can find it.",
  inputSchema: { type: "object", properties: {
    name: { type: "string", description: "The design's title, exactly as the artifact or document is titled in this chat" },
    type: { type: "string", enum: DESIGN_TYPES, description: "What kind of design it is" },
    staff: { type: "string", description: "The staff member it belongs to, by title, if he said or if this chat is plainly that staff member's" },
    profile: { type: "string", description: "The profile it belongs to, if he said" },
    folder: { type: "string", description: "The folder to save it in, if he named one" },
    file: { type: "string", description: "If the design is a file you made in this chat (a .pptx, .pdf, .docx, .mp4 and so on), its exact file name" },
    link: { type: "string", description: "The design's claude.ai address, only if you know it for certain. Never guess one." },
  }, required: ["name"] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const ASK_TOOLS = [{
  name: "lookup_address",
  title: "Find a person's email address",
  description: "Ask the user's Mac for the email address of someone he writes to, by name. Use this before handing over an email or meeting when you have only a name. It returns up to three matches from the people he corresponds with. If nothing comes back, give the name as it is and he will pick the address.",
  inputSchema: { type: "object", properties: { name: { type: "string", description: "The person's name, as he said it" } }, required: ["name"] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, {
  name: "find_free_time",
  title: "Find when he is free",
  description: "Ask the user's Mac when he is free between two days, across all his calendars. It returns free stretches only (no meeting titles, no people), in his own time zone. Use it before proposing a meeting time.",
  inputSchema: { type: "object", properties: { from: { type: "string", description: "First day, YYYY-MM-DD" }, to: { type: "string", description: "Last day, YYYY-MM-DD (at most 14 days after the first)" }, minutes: { type: "integer", description: "How long the meeting is. Default 30." }, earliest: { type: "string", description: "Earliest time of day, HH:MM. Default 09:00." }, latest: { type: "string", description: "Latest finishing time of day, HH:MM. Default 17:00." }, weekends: { type: "boolean", description: "true to include Saturday and Sunday" } }, required: ["from", "to"] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, {
  name: "list_staff",
  title: "See who his staff are",
  description: "Ask the user's Mac for his staff in each of his profiles: each one's title and what they do. Use it to decide who an action is for, so you can name them exactly.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];

// ---------- The panel shown in the chat ----------
// Where the chat can show a connector's own panel (the "ui" extension), the hand-over is laid out there: what was
// handed over, that it is waiting in the app, and a button to see what he has done with it. The page is self-contained:
// it loads nothing from anywhere, and everything it shows is put in as plain text.
const UI_URI = "ui://chief-of-staff-app/handover", UI_MIME = "text/html;profile=mcp-app";
const UI_HTML = String.raw`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 14px 16px; font: 14px/1.4 var(--font-sans, system-ui, -apple-system, sans-serif); background: transparent; color: var(--color-text-primary, light-dark(#1d1d1f, #f2f2f2)); }
  h1 { font-size: 15px; margin: 0 0 2px; font-weight: 600; }
  .sub { font-size: 12px; opacity: .65; margin: 0 0 10px; }
  .it { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; border-top: 1px solid light-dark(rgba(0,0,0,.09), rgba(255,255,255,.14)); }
  .k { flex: none; width: 74px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .6; }
  .t { flex: 1; min-width: 0; } .t b { font-weight: 600; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .t span { font-size: 12px; opacity: .7; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .top { display: flex; gap: 8px; align-items: center; font-size: 12px; margin: 0 0 10px; } .top span { opacity: .65; }
  .ed { display: grid; gap: 6px; padding: 2px 0 12px 84px; }
  .ed label { display: flex; gap: 8px; align-items: center; font-size: 12px; } .ed label span { flex: none; width: 54px; opacity: .65; }
  input, select { flex: 1; min-width: 0; font: inherit; font-size: 13px; padding: 4px 7px; border-radius: 6px; border: 1px solid light-dark(rgba(0,0,0,.18), rgba(255,255,255,.25)); background: light-dark(#fff, rgba(255,255,255,.06)); color: inherit; }
  .top select { flex: none; max-width: 260px; }
  .ed .row { display: flex; gap: 8px; justify-content: flex-end; }
  .go .e { border-color: transparent; opacity: .7; padding: 3px 6px; } .go .e:hover { opacity: 1; }
  .go { flex: none; display: flex; gap: 6px; align-items: center; }
  .go button { font-size: 12px; padding: 3px 10px; border-radius: 7px; } .go .x { padding: 3px 7px; border-color: transparent; opacity: .6; } .go .x:hover { opacity: 1; }
  .go .main { background: light-dark(#17384a, #dfe9ee); color: light-dark(#fff, #10222c); border-color: transparent; }
  .st { flex: none; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: light-dark(rgba(0,0,0,.07), rgba(255,255,255,.14)); white-space: nowrap; }
  .st.done { background: light-dark(#dff3e4, #1f4a2c); } .st.gone { opacity: .55; } .st.bad { background: light-dark(#fbe1dc, #5a2520); }
  .foot { display: flex; gap: 10px; align-items: center; margin-top: 10px; padding-top: 10px; border-top: 1px solid light-dark(rgba(0,0,0,.09), rgba(255,255,255,.14)); }
  .foot span { flex: 1; font-size: 12px; opacity: .7; }
  button { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 8px; border: 1px solid light-dark(rgba(0,0,0,.18), rgba(255,255,255,.25)); background: transparent; color: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style></head>
<body>
<h1 id="h">For your Chief of Staff app</h1>
<p class="sub" id="sub">Preparing</p>
<div class="top" id="top" hidden><span>Profile</span><select id="prof"></select></div>
<div id="list"></div>
<div class="foot"><span id="note">Open an item to check it in your app, or edit it here first. Nothing is sent until you send it.</span><button id="chk" disabled>See What Happened</button></div>
<script>
(function () {
  var nextId = 1, pending = {}, args = null, ref = "", host = {}, pick = null, editing = "", lastState = null;
  // What he does here is passed to Claude quietly (no message in the chat), so its next answer already knows.
  function tell(text) { request("ui/update-model-context", { content: [{ type: "text", text: text }] }).catch(function () {}); }
  var ONE = { emails: "email", meetings: "meeting", changes: "change", actions: "action", documents: "document" };
  function stateWords(state) { var out = []; ["emails", "meetings", "changes", "actions", "documents"].forEach(function (k) { (state && state[k] || []).forEach(function (v, n) { out.push(ONE[k] + " " + (n + 1) + " " + v); }); }); return out.join("; "); }
  function send(m) { window.parent.postMessage(m, "*"); }
  function request(method, params) { var id = nextId++; send({ jsonrpc: "2.0", id: id, method: method, params: params }); return new Promise(function (res, rej) { pending[id] = { res: res, rej: rej }; setTimeout(function () { if (pending[id]) { delete pending[id]; rej(new Error("no answer")); } }, 20000); }); }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function vars(ctx) { try { var v = (ctx && ctx.styles && ctx.styles.variables) || {}; for (var k in v) if (v[k]) document.documentElement.style.setProperty(k, v[k]); } catch (e) {} }
  function when(v) { var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(v || "")); if (!m) return v || ""; var d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)); var s = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }); return m[4] ? s + ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : s; }
  var WORD = { waiting: "Waiting", opened: "Opened", done: "Done", added: "Added", made: "Made", dismissed: "Dismissed", failed: "Did not work" };
  function rows() {
    var out = [], a = args || {};
    (a.emails || []).forEach(function (m) { var f = (m.attach || []).length; out.push(["emails", m.reply_to ? "Reply" : "Email", m.subject || (m.reply_to && m.reply_to.subject) || "(No subject)", (m.to ? "To " + m.to : (m.reply_to && m.reply_to.from ? "To " + m.reply_to.from : "")) + (f ? (f === 1 ? " · 1 file" : " · " + f + " files") : "")]); });
    (a.meetings || []).forEach(function (m) { out.push(["meetings", "Meeting", m.title || "Meeting", [when(m.date), m.start && (m.start + (m.end ? " to " + m.end : "")), m.where].filter(Boolean).join(" · ")]); });
    (a.changes || []).forEach(function (c) { var w = { add_event: "Calendar", change_event: "Calendar", remove_event: "Calendar", add_rule: "Mail rule", add_folder: "Folder" }[c.do] || "Change", v = { add_event: "Add", change_event: "Change", remove_event: "Remove", add_rule: "Add", add_folder: "Add" }[c.do] || ""; out.push(["changes", w, (v ? v + " “" : "“") + (c.title || c.find || c.name || "") + "”", [when(c.start || c.date), c.where].filter(Boolean).join(" · ")]); });
    (a.actions || []).forEach(function (x) { out.push(["actions", "Action", x.action || "", x.for ? "For the " + x.for : "You choose who it is for"]); });
    (a.documents || []).forEach(function (x) { out.push(["documents", "Document", x.title || "Document", "A Word file in a folder you choose"]); });
    return out;
  }
  var FIELDS = { emails: [["to", "To", "text"], ["cc", "Cc", "text"], ["subject", "Subject", "text"]], meetings: [["title", "Title", "text"], ["date", "Date", "date"], ["start", "Start", "time"], ["end", "End", "time"]], actions: [["for", "For", "staff"], ["action", "Action", "text"]] };
  function staffNames() { var s = (pick && pick.staff) || {}, prof = (document.getElementById("prof").value) || (pick && (pick.account || pick.active)) || "", l = s[prof]; if (!l) { l = []; for (var k in s) l = l.concat(s[k] || []); } var seen = {}, out = []; l.forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } }); return out; }
  function form(kind, n) {
    var item = ((args || {})[kind] || [])[n] || {}, box = el("div", "ed"), ins = {};
    FIELDS[kind].forEach(function (f) {
      var lab = el("label"); lab.appendChild(el("span", "", f[1])); var inp;
      if (f[2] === "staff") { inp = document.createElement("select"); var names = staffNames(); names.concat(["I will choose in the app"]).forEach(function (nm, k) { var o = el("option", "", nm); o.value = k < names.length ? nm : ""; inp.appendChild(o); }); inp.value = names.indexOf(item[f[0]]) >= 0 ? item[f[0]] : ""; }
      else { inp = document.createElement("input"); inp.type = f[2]; inp.value = item[f[0]] == null ? "" : String(item[f[0]]); }
      ins[f[0]] = inp; lab.appendChild(inp); box.appendChild(lab);
    });
    var row = el("div", "row"), save = el("button", "main", "Save"); save.className = "main";
    save.addEventListener("click", function () {
      var set = {}, any = false; FIELDS[kind].forEach(function (f) { var v = ins[f[0]].value, was = item[f[0]] == null ? "" : String(item[f[0]]); if (v !== was) { set[f[0]] = v; any = true; } });
      if (!any) { editing = ""; paint(lastState); return; }
      save.disabled = true; amend(kind, n, set, function () { for (var k in set) item[k] = set[k]; editing = ""; paint(lastState); sub("Changed. Your app has the new version."); tell("In the panel he changed " + ONE[kind] + " " + (n + 1) + " before opening it: " + Object.keys(set).join(", ") + ". His app has the corrected version."); }, function (why) { save.disabled = false; sub(why || "It could not be changed here. Change it in the app."); });
    });
    row.appendChild(save); box.appendChild(row); return box;
  }
  function amend(kind, n, set, ok, bad) {
    var a = { ref: ref, kind: kind, index: n, do: "amend", set: set };
    if (!host.serverTools) return bad("This chat cannot pass changes on. Change it in the app.");
    request("tools/call", { name: "act_on_item", arguments: a }).then(function (r) { if (r && r.isError) bad(r.content && r.content[0] && r.content[0].text); else ok(); }, function () { bad(); });
  }
  function top() {
    var t = document.getElementById("top"), sel = document.getElementById("prof"), names = (pick && pick.profiles) || [];
    if (!ref || !pick || names.length < 2) { t.hidden = true; return; }
    if (!sel.options.length) {
      names.concat(["I will choose in the app"]).forEach(function (nm, k) { var o = el("option", "", nm); o.value = k < names.length ? nm : ""; sel.appendChild(o); });
      var cur = pick.account || pick.active || ""; sel.value = names.indexOf(cur) >= 0 ? cur : (names.filter(function (x) { return x.toLowerCase() === String(cur).toLowerCase(); })[0] || "");
      sel.addEventListener("change", function () { var v = sel.value; sel.disabled = true; amend("handover", 0, { for_account: v }, function () { sel.disabled = false; pick.account = v; sub(v ? "It will go into " + v : "You will choose the profile in the app"); tell("In the panel he set the profile for this hand-over to " + (v || "choose later in the app") + "."); if (editing) paint(lastState); }, function (why) { sel.disabled = false; sub(why || "The profile could not be changed here."); }); });
    }
    t.hidden = false;
  }
  function paint(state) {
    lastState = state; top();
    var a = args || {}, list = document.getElementById("list"), seen = {}; list.textContent = "";
    document.getElementById("h").textContent = a.summary || "For your Chief of Staff app";
    rows().forEach(function (r) {
      var i = seen[r[0]] = (seen[r[0]] == null ? 0 : seen[r[0]] + 1), st = state && state[r[0]] && state[r[0]][i];
      var it = el("div", "it"); it.appendChild(el("span", "k", r[1])); var t = el("div", "t"); t.appendChild(el("b", "", r[2])); if (r[3]) t.appendChild(el("span", "", r[3])); it.appendChild(t);
      if (st) it.appendChild(el("span", "st" + (st === "waiting" ? "" : st === "dismissed" ? " gone" : st === "failed" ? " bad" : " done"), WORD[st] || st));
      if (ref && st !== "dismissed") {
        var g = el("span", "go"), verb = { emails: "Open", meetings: "Open", changes: "Review", actions: "Add", documents: "Make" }[r[0]] || "Open";
        var b = el("button", st && st !== "waiting" ? "" : "main", st && st !== "waiting" && r[0] !== "changes" ? (verb === "Open" ? "Open Again" : verb) : verb); b.title = "Opens it in your Chief of Staff app. Nothing is sent.";
        b.addEventListener("click", (function (kind, n, btn) { return function () { act(kind, n, "open", btn); }; })(r[0], i, b)); g.appendChild(b);
        if (pick && (!st || st === "waiting") && FIELDS[r[0]]) { var e = el("button", "e", editing === r[0] + ":" + i ? "Close" : "Edit"); e.title = "Change it here before you open it"; e.addEventListener("click", (function (key) { return function () { editing = editing === key ? "" : key; paint(lastState); }; })(r[0] + ":" + i)); g.appendChild(e); }
        if (!st || st === "waiting") { var x = el("button", "x", "×"); x.title = "Take this one off the list"; x.addEventListener("click", (function (kind, n, btn) { return function () { act(kind, n, "dismiss", btn); }; })(r[0], i, x)); g.appendChild(x); }
        it.appendChild(g);
      }
      list.appendChild(it);
      if (ref && editing === r[0] + ":" + i) list.appendChild(form(r[0], i));
    });
    size();
  }
  function size() { try { var r = document.documentElement.getBoundingClientRect(); notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: Math.ceil(document.body.scrollHeight) }); } catch (e) {} }
  function sub(t) { document.getElementById("sub").textContent = t; }
  function fromResult(res) {
    var sc = (res && res.structuredContent) || {}, tx = res && res.content && res.content[0] && res.content[0].text || "";
    if (sc.states) { var one = sc.states[0]; if (one) { if (!ref) ref = one.ref || ""; paint(one.state); sub("As at " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })); var w = stateWords(one.state); if (w && w !== toldState) { toldState = w; tell("What he has done so far with the hand-over to his Chief of Staff app (reference " + ref + "): " + w + ". Opened means it is with him to check and send; nothing is known to be sent."); } } return; }
    if (res && res.isError) { sub(tx || "It could not be handed over."); return; }
    if (sc.asked) return;
    if (sc.ref) { ref = sc.ref; pick = sc.pick || null; sub("Waiting in your Chief of Staff app for you to approve"); document.getElementById("chk").disabled = false; paint(sc.state || null); }
    else if (tx) sub(tx.slice(0, 160));
  }
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return; var m = ev.data; if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method) { var p = pending[m.id]; if (p) { delete pending[m.id]; if (m.error) p.rej(m.error); else p.res(m.result); } return; }
    if (m.method === "ui/notifications/tool-input" || m.method === "ui/notifications/tool-input-partial") { if (m.params && m.params.arguments) { args = m.params.arguments; paint(null); if (m.method === "ui/notifications/tool-input") sub("Handing it to your app"); } }
    else if (m.method === "ui/notifications/tool-result") fromResult(m.params);
    else if (m.method === "ui/notifications/host-context-changed") vars(m.params);
    else if (m.method === "ui/resource-teardown" && m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  });
  document.getElementById("chk").addEventListener("click", function () {
    var b = this; b.disabled = true; sub("Checking");
    var again = function () { b.disabled = false; };
    if (host.serverTools) request("tools/call", { name: "check_outcome", arguments: ref ? { ref: ref } : {} }).then(function (r) { fromResult(r); again(); }, function () { ask(); again(); });
    else { ask(); again(); }
  });
  var toldState = "";
  function act(kind, n, what, btn) {
    btn.disabled = true; sub(what === "open" ? "Asking your app to open it" : "Taking it off the list");
    var a = { ref: ref, kind: kind, index: n, do: what };
    var done = function () { sub(what === "open" ? "Opening in your Chief of Staff app (a few seconds)" : "Taken off the list"); tell(what === "open" ? "In the panel he pressed to open " + ONE[kind] + " " + (n + 1) + " in his app. It is with him to check; nothing has been sent." : "In the panel he took " + ONE[kind] + " " + (n + 1) + " off the list. Do not hand it over again unless he asks."); setTimeout(refresh, 7000); };
    var viaClaude = function () { request("ui/message", { role: "user", content: [{ type: "text", text: (what === "open" ? "Open" : "Dismiss") + " item " + (n + 1) + " of the " + kind + " you handed to my Chief of Staff app (reference " + ref + "), using act_on_item." }] }).then(function () { sub("Asked Claude to do it"); }, function () { btn.disabled = false; sub("It could not be passed on. Open it from the app."); }); };
    if (host.serverTools) request("tools/call", { name: "act_on_item", arguments: a }).then(function (r) { if (r && r.isError) { btn.disabled = false; sub((r.content && r.content[0] && r.content[0].text) || "It could not be passed on."); } else done(); }, viaClaude);
    else viaClaude();
  }
  function refresh() { if (!host.serverTools) return; request("tools/call", { name: "check_outcome", arguments: ref ? { ref: ref } : {} }).then(function (r) { fromResult(r); }, function () {}); }
  function ask() { sub("Asked Claude to check"); request("ui/message", { role: "user", content: [{ type: "text", text: "What happened to what you handed to my Chief of Staff app" + (ref ? " (reference " + ref + ")" : "") + "? Check with check_outcome." }] }).catch(function () { sub("Ask Claude: what happened to what you handed over?"); }); }
  try { new ResizeObserver(size).observe(document.body); } catch (e) {}
  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "chief-of-staff-app", version: "1.0.0" }, appCapabilities: { availableDisplayModes: ["inline"] } }).then(function (r) { host = (r && r.hostCapabilities) || {}; vars(r && r.hostContext); notify("ui/notifications/initialized", {}); size(); }, function () { notify("ui/notifications/initialized", {}); });
})();
</script></body></html>`;

// ---------- The skill the connector carries ----------
// How to use the one tool well, sent with the connector itself (the "skills" extension of the newer standard), so the
// guidance does not have to be pasted into each project's instructions. It is plain words: no scripts, no other files.
const SKILL_NAME = "chief-of-staff-app", SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`;
const SKILL_DESC = "How to hand emails, meetings, calendar entries, mail rules and folders, actions for his staff and documents to the user's Chief of Staff app for his approval. Use whenever he asks you to draft or send an email, reply to one, set up or change a meeting, put something in his calendar, make a mail rule or folder, give a staff member something to do, or save something as a document.";
const SKILL_MD = `---
name: ${SKILL_NAME}
description: ${SKILL_DESC}
---

# Handing things to the Chief of Staff app

The user runs a Mac app called Chief of Staff. It holds his mail, calendar, staff and company folders. You cannot
change any of those yourself. You hand him what you propose with the tool \`show_for_approval\`, and he approves each
item in the app. Nothing is sent, made or changed until he does.

## The rules that never bend

- He sends every email and every invitation himself. Never say something was sent, booked or changed. Say it is
  waiting in his app.
- Use \`show_for_approval\` for making or changing things, and no other calendar or email tool, even if one is
  connected. Other tools are for looking things up.
- Put everything from one request into a single call. Do not call it once per item.
- After the call, tell him in one short line that it is waiting in the Chief of Staff app. Do not repeat the whole
  contents back to him.
- Never use em dashes in anything you write for him. Use Australian English spelling.

## Choosing the right kind of item

- \`emails\`: anything he will send to someone. No signature, his mail app adds it.
- \`meetings\`: anything with other people invited. It opens as an invitation for him to check.
- \`changes\`: entries in his own calendar with nobody invited (\`add_event\`, \`change_event\`, \`remove_event\`), and
  mail rules and folders (\`add_rule\`, \`add_folder\`). If other people should know about a calendar entry, it is a
  meeting, not a change.
- \`actions\`: a to-do for one of his staff members. One short line starting with a verb.
- \`documents\`: something to keep as a Word file in a company folder. He chooses the folder.

## Emails

- For a reply, give \`reply_to\` with the subject of the email being answered, exactly as written, plus who sent it
  and the date if you know them. The app finds that email and puts the earlier messages underneath.
- In a reply, write only the new words. Do not paste the earlier emails into the body.
- Set \`reply_all\` to true only when everyone on the email should get the answer.
- Give addresses only when you are certain of them. Otherwise give the person's name exactly, and he picks the
  address. Never guess an address.

## Attaching a file to an email

The app can only attach a file that is on his Mac, inside his company folders. It cannot take a file from this chat.

- If you made the file here (a PDF, a Word document, a spreadsheet), save it into his folder on the Mac first, in the
  folder of the staff member or project it belongs to. Then give its path in \`attach\` on the email, exactly as saved.
- Give the full path, or the path starting from the top folder, including the file's ending (".pdf").
- If you do not have access to his folder, ask to use the top folder. If that is not possible, leave \`attach\` out,
  say plainly in your reply that the file is not attached, and tell him where the file is so he can attach it himself.
- Never write "attached" or "please find attached" in an email unless you gave the file in \`attach\`.

## Meetings and calendar entries

- Give times as they are on the clock where the thing happens. When that place is not his home time zone, add
  \`time_zone\` as an IANA name such as "Australia/Perth". Do not convert times yourself.
- To change or remove an entry, name it by its title exactly as it shows in his calendar, and the day it is on.
  Never give an id for a calendar entry or an email. The app has its own and yours will not match.
- Put anything you assumed into \`check\` on a meeting, so he sees it before he saves.
- In \`invite\`, separate people with semicolons.

## Which account

He has more than one organisation and mailbox. When the chat makes it clear which one this belongs to, say so in
\`for_account\`, in his own words or as an email address. If it is not clear, leave it out and he chooses in the app.

## Saving a design to his Design Studio

His app has a Design Studio: finished designs he has chosen to keep (presentations, proposals, documents, videos). Nothing goes there by itself. When, and only when, he asks you to save something there ("save this to the Design Studio", "add this to my designs"), call save_design with the design's exact title as it appears in this chat, its type, and the file name if it is a file you made. He confirms the details in a short form. Never call it on your own initiative, and never for drafts or ordinary answers.

## Small questions his Mac can answer

Three tools ask the app on his Mac one narrow thing each. They are quick, and they give you only what you asked for.

- \`lookup_address\`: the email address of someone he writes to, from a name. Use it before handing over an email or
  a meeting when you have only a name. If nothing comes back, give the name and he picks the address.
- \`find_free_time\`: when he is free between two days, across all his calendars. It gives free stretches only. Use it
  before you propose a meeting time, and offer two or three of the times it returns.
- \`list_staff\`: his staff in each profile and what each does. Use it to name the right person for an action.

If his Mac does not answer, the app is shut or the Mac is asleep. Carry on, and say what you could not check.

## Finding out what he did

You do not see what he does in the app unless you ask. \`show_for_approval\` gives you a reference. Use
\`check_outcome\` with it:

- before you say that anything was sent, booked, added or changed;
- when he asks what happened, or asks you to carry on from where things are.

It tells you, for each item in the order you gave them, whether it is waiting, opened, done, dismissed or did not
work. An email or meeting that was opened is with him to check and send: you still cannot know that he sent it, so
never say it was sent. If something was dismissed, do not hand it over again unless he asks. If he says something
was not right, hand him a corrected version in a new call.
`;
const skillEntry = async () => { const bytes = new TextEncoder().encode(SKILL_MD); return { uri: SKILL_URI, frontmatter: { name: SKILL_NAME, description: SKILL_DESC }, resources: [{ uri: SKILL_URI, digest: "sha256:" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join(""), size: bytes.length }] }; };
const CACHE = { ttlMs: 300000, cacheScope: "private" };
const CAPS = { tools: {}, resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } };

// ---------- The protocol ----------
// Two eras are spoken at once. The older one opens with an "initialize" handshake. The newer one (2026-07-28) has no
// handshake: every request says which version it speaks, in its _meta and in a header, and is answered by itself.
// A request is treated as the newer kind when it carries that version in its _meta; anything else is the older kind.
const MODERN = ["2026-07-28"], LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PV = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO = { name: "chief-of-staff-app", title: "Chief of Staff app", version: "1.8.0" };
const INSTRUCTIONS = "Use show_for_approval to hand emails, meetings and calendar or mail changes to the user's app, where he approves them. It never sends or changes anything by itself.";
// Only Claude's own pages may call this from a browser (a request from Claude's servers carries no Origin at all).
const originOk = (o: string | null) => { if (!o) return true; try { const h = new URL(o).hostname.toLowerCase(); return ["claude.ai", "claude.com", "anthropic.com"].some(d => h === d || h.endsWith("." + d)); } catch { return false; } };

type Ans = { body: unknown; status: number } | null;
async function mcp(req: Request, secret: string) {
  if (!originOk(req.headers.get("origin"))) return json({ jsonrpc: "2.0", error: { code: -32600, message: "origin not allowed" } }, 403);
  const sHash = await sha(secret);
  const box = await (await db(`cos_boxes?s_hash=eq.${sHash}&select=pub,profiles,ctx`)).json().catch(() => []);
  if (!Array.isArray(box) || !box.length) return json({ error: "not found" }, 404);
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const raw = await req.text(); if (raw.length > 400_000) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "too large" } }, 413);
  let msg: any; try { msg = JSON.parse(raw); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
  const hdr = (n: string) => { const v = req.headers.get(n); return v === null ? null : v.trim(); };
  const one = async (m: any, single: boolean): Promise<Ans> => {
    if (!m || m.id === undefined || m.id === null) return null;                                   // a notification: nothing to answer
    const p = m.params || {}, meta = (p && typeof p._meta === "object" && p._meta) || {};
    const asked = typeof meta[PV] === "string" ? meta[PV] : "";
    const modern = m.method !== "initialize" && !!asked && !LEGACY.includes(asked);
    // A one-line note of which call this was, for finding out what Claude asks for. Names only: never what was handed over.
    try { const ci = meta["io.modelcontextprotocol/clientInfo"] || (p.clientInfo || {}), cc = meta["io.modelcontextprotocol/clientCapabilities"] || p.capabilities || {}; console.log("mcp " + JSON.stringify({ call: String(m.method).slice(0, 60), style: modern ? asked : "older", client: `${String(ci.name || "").slice(0, 40)} ${String(ci.version || "").slice(0, 20)}`.trim(), can: Object.keys(cc).slice(0, 12), ext: Object.keys((cc && cc.extensions) || {}).slice(0, 12), ...(m.method === "resources/read" || m.method === "skills/get" ? { uri: String(p.uri || "").slice(0, 80) } : {}) })); } catch { /* the call is answered all the same */ }
    const err = (code: number, message: string, status: number, data?: unknown): Ans => ({ body: { jsonrpc: "2.0", id: m.id, error: data === undefined ? { code, message } : { code, message, data } }, status: modern ? status : 200 });
    // every answer in the newer era says it is complete; the older era's answers are left exactly as they were
    const ok = (result: Record<string, unknown>): Ans => ({ body: { jsonrpc: "2.0", id: m.id, result: modern ? { resultType: "complete", ...result } : result }, status: 200 });
    if (modern) {
      if (!MODERN.includes(asked)) return err(-32022, "Unsupported protocol version", 400, { supported: MODERN.concat(LEGACY), requested: asked });
      // (only when this is the one request in the body: the headers describe a single request)
      if (single) {
        const hv = hdr("mcp-protocol-version"), hm = hdr("mcp-method"), hn = hdr("mcp-name");
        if (hv !== null && hv !== asked) return err(-32020, "The MCP-Protocol-Version header does not match the request", 400);
        if (hm !== null && hm !== m.method) return err(-32020, "The Mcp-Method header does not match the request", 400);
        if (hn !== null && m.method === "resources/read" && hn !== String(p.uri || "")) return err(-32020, "The Mcp-Name header does not match the request", 400);
        if (hn !== null && m.method === "tools/call" && hn !== String(p.name || "")) return err(-32020, "The Mcp-Name header does not match the request", 400);
      }
    }
    if (m.method === "initialize") return ok({ protocolVersion: LEGACY.includes(p.protocolVersion) ? p.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    // Who this is and what it speaks. Answered whether or not the caller has said its version yet (this is how it finds out).
    if (m.method === "server/discover") return { body: { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", supportedVersions: MODERN.concat(LEGACY), capabilities: CAPS, instructions: INSTRUCTIONS, ttlMs: 3600000, cacheScope: "private", _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } } }, status: 200 };
    if (m.method === "ping") return ok({});
    // The skill: listed, described, and read as a single page of words.
    if (m.method === "skills/list") return ok({ skills: [await skillEntry()], ...CACHE });
    if (m.method === "skills/get") return p.uri === SKILL_URI ? ok({ skill: await skillEntry(), ...CACHE }) : err(-32602, `No skill is served at ${String(p.uri || "").slice(0, 200)}`, 400);
    if (m.method === "resources/list") return ok({ resources: [{ uri: SKILL_URI, name: "SKILL.md", title: "How to use the Chief of Staff app", mimeType: "text/markdown" }], ...CACHE });
    if (m.method === "resources/templates/list") return ok({ resourceTemplates: [], ...CACHE });
    if (m.method === "resources/read" && p.uri === UI_URI) return ok({ contents: [{ uri: UI_URI, mimeType: UI_MIME, text: UI_HTML, _meta: { ui: { prefersBorder: true } } }], ...CACHE });
    if (m.method === "resources/read") return p.uri === SKILL_URI ? ok({ contents: [{ uri: SKILL_URI, mimeType: "text/markdown", text: SKILL_MD }], ...CACHE }) : err(-32602, "No such resource", 400);
    const ctx = (box[0].ctx && typeof box[0].ctx === "object" ? box[0].ctx : {}) as Record<string, any>;
    const caps = (meta["io.modelcontextprotocol/clientCapabilities"] || p.capabilities || {}) as Record<string, any>;
    const uiCap = caps.extensions && caps.extensions["io.modelcontextprotocol/ui"];
    const panel = ctx.panel !== false && !!uiCap && (!Array.isArray(uiCap.mimeTypes) || uiCap.mimeTypes.includes(UI_MIME));
    const answers = ctx.answers === true;        // (an older app says nothing about it, and could not answer)
    const toolList = () => TOOLS.map(t => panel && t.name === "show_for_approval" ? { ...t, _meta: { ui: { resourceUri: UI_URI, visibility: ["model", "app"] }, "ui/resourceUri": UI_URI } } : t).concat(ctx.studio === true ? [DESIGN_TOOL as any] : []).concat(answers ? ASK_TOOLS as any[] : []);
    if (m.method === "tools/list") return ok(modern ? { tools: toolList(), ttlMs: 300000, cacheScope: "private" } : { tools: toolList() });
    if (m.method === "tools/call") {
      const a = p.arguments || {};
      const KINDS = ["emails", "meetings", "changes", "actions", "documents"];
      // What he did with it: only the state of each item, by its place in the list. Never what the items were.
      if (p.name === "check_outcome") {
        const want = typeof a.ref === "string" && /^[0-9a-f]{10}$/.test(a.ref) ? a.ref : "";
        const got = await (await db(`cos_outcomes?s_hash=eq.${sHash}${want ? `&ref=eq.${want}` : ""}&select=ref,state,created_at,updated_at&order=created_at.desc&limit=${want ? 1 : 5}`)).json().catch(() => []);
        const list = Array.isArray(got) ? got : [];
        if (!list.length) return ok({ content: [{ type: "text", text: want ? `Nothing is recorded for reference ${want}. It may be more than a week old.` : "Nothing has been handed over in the last week." }], structuredContent: { states: [] } });
        const SAY: Record<string, string> = { waiting: "waiting in the app (he has not dealt with it)", opened: "opened for him to check and send (you cannot know whether he sent it)", done: "done", added: "added", made: "made", dismissed: "dismissed (he chose not to do it)", failed: "did not work" };
        const ONE: Record<string, string> = { emails: "Email", meetings: "Meeting", changes: "Change", actions: "Action", documents: "Document" };
        const text = list.map((o: any) => { const st = (o.state && typeof o.state === "object" ? o.state : {}) as Record<string, string[]>; const lines: string[] = [];
          for (const k of KINDS) (Array.isArray(st[k]) ? st[k] : []).forEach((v, n) => lines.push(`- ${ONE[k]} ${n + 1}: ${SAY[v] || v}`));
          return `Reference ${o.ref}, handed over ${String(o.created_at).slice(0, 16).replace("T", " ")} UTC:\n${lines.join("\n") || "- nothing listed"}`; }).join("\n\n");
        return ok({ content: [{ type: "text", text: text + "\n\nItems are numbered in the order you gave them. Do not say anything was sent: he sends emails and invitations himself." }], structuredContent: { states: list.map((o: any) => ({ ref: o.ref, state: o.state })) } });
      }
      // A small question for his Mac. It is left for the app to collect, and this call waits (up to about 25 seconds)
      // for the answer, which is passed on and wiped. If the Mac is asleep or the app is shut, Claude is told so.
      if (ASK_TOOLS.some(t => t.name === p.name)) {
        if (!answers) return ok({ content: [{ type: "text", text: "He has turned off questions to his Mac. Carry on without it." }], isError: true });
        const args: Record<string, unknown> = {};
        if (p.name === "lookup_address") { args.name = String(a.name || "").trim().slice(0, 120); if (!args.name) return ok({ content: [{ type: "text", text: "Give the person's name." }], isError: true }); }
        if (p.name === "find_free_time") {
          const D = /^\d{4}-\d{2}-\d{2}$/, T = /^\d{2}:\d{2}$/;
          if (!D.test(String(a.from)) || !D.test(String(a.to))) return ok({ content: [{ type: "text", text: "Give from and to as YYYY-MM-DD." }], isError: true });
          Object.assign(args, { from: a.from, to: a.to, minutes: Math.max(10, Math.min(480, Number(a.minutes) || 30)), earliest: T.test(String(a.earliest)) ? a.earliest : "09:00", latest: T.test(String(a.latest)) ? a.latest : "17:00", weekends: a.weekends === true });
        }
        await db(`cos_asks?s_hash=eq.${sHash}&created_at=lt.${new Date(Date.now() - 60e3).toISOString()}`, { method: "DELETE" });
        const made = await (await db("cos_asks", { method: "POST", body: JSON.stringify({ s_hash: sHash, kind: p.name, args }) })).json().catch(() => []);
        const qid = Array.isArray(made) && made[0] && made[0].id;
        if (!qid) return ok({ content: [{ type: "text", text: "The question could not be passed to his Mac just now." }], isError: true });
        let answer: any = null;
        for (let i = 0; i < 50 && answer === null; i++) {
          await new Promise(r => setTimeout(r, 500));
          const row = await (await db(`cos_asks?id=eq.${qid}&select=answer`)).json().catch(() => []);
          if (Array.isArray(row) && row[0] && row[0].answer !== null && row[0].answer !== undefined) answer = row[0].answer;
        }
        await db(`cos_asks?id=eq.${qid}`, { method: "DELETE" });
        if (answer === null) return ok({ content: [{ type: "text", text: "His Mac did not answer: the Chief of Staff app may be shut, or the Mac asleep. Carry on without it, and say what you could not check." }], isError: true });
        const text = typeof answer.text === "string" ? answer.text.slice(0, 6000) : "No answer.";
        return ok({ content: [{ type: "text", text }] });
      }
      // A button in the panel: the app is asked to open that item, or take it off the list. It collects the request
      // within a few seconds. Nothing about the item itself is kept here: only which one, and what to do.
      if (p.name === "act_on_item") {
        const okRef = typeof a.ref === "string" && /^[0-9a-f]{10}$/.test(a.ref), idx = Number(a.index);
        const whole = a.kind === "handover";
        if (!okRef || !(KINDS.includes(a.kind) || whole) || !Number.isInteger(idx) || idx < 0 || idx > 99 || !["open", "dismiss", "amend"].includes(a.do) || (whole && a.do !== "amend")) return ok({ content: [{ type: "text", text: "That is not an item that was handed over." }], isError: true });
        const known = await (await db(`cos_outcomes?s_hash=eq.${sHash}&ref=eq.${a.ref}&select=state`)).json().catch(() => []);
        const have = Array.isArray(known) && known[0] && known[0].state && typeof known[0].state === "object" ? known[0].state : null;
        const st = have && !whole && Array.isArray(have[a.kind]) ? have[a.kind] : null;
        if (!have || (!whole && (!st || idx >= st.length))) return ok({ content: [{ type: "text", text: "That item is not among what was handed over under that reference." }], isError: true });
        // (a correction made in the panel before he opens it: only the fields that kind of item has, as short plain text)
        let data: Record<string, string> | null = null;
        if (a.do === "amend") {
          const FIELDS: Record<string, string[]> = { emails: ["to", "cc", "subject"], meetings: ["title", "date", "start", "end", "invite", "where"], actions: ["for", "action"], handover: ["for_account"], changes: [], documents: ["title"] };
          data = {}; const set = a.set && typeof a.set === "object" ? a.set : {};
          for (const k of FIELDS[a.kind] || []) if (typeof set[k] === "string") data[k] = set[k].replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 400);
          if (!Object.keys(data).length) return ok({ content: [{ type: "text", text: "Nothing to change was given." }], isError: true });
        }
        await db(`cos_cmds?s_hash=eq.${sHash}&created_at=lt.${new Date(Date.now() - 600e3).toISOString()}`, { method: "DELETE" });
        const r = await db("cos_cmds", { method: "POST", body: JSON.stringify({ s_hash: sHash, ref: a.ref, kind: a.kind, idx, act: a.do, data }) });
        if (!r.ok) return ok({ content: [{ type: "text", text: "It could not be passed to the app just now. Try again in a moment." }], isError: true });
        return ok({ content: [{ type: "text", text: a.do === "open" ? "His app has been asked to open it. It opens within a few seconds if the app is running on his Mac. Nothing has been sent." : a.do === "amend" ? "His app has been given the correction. It applies before he opens the item." : "His app has been asked to take it off the list." }], structuredContent: { asked: a.do, kind: a.kind, index: idx } });
      }
      if (p.name === "save_design") {
        if (ctx.studio !== true) return ok({ content: [{ type: "text", text: "His app does not have the Design Studio yet. Ask him to update the Chief of Staff app." }], isError: true });
        const clip = (v: unknown, n: number) => String(v == null ? "" : v).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n);
        const D: Record<string, string> = { name: clip(a.name, 140), type: DESIGN_TYPES.includes(String(a.type)) ? String(a.type) : "", staff: clip(a.staff, 80), profile: clip(a.profile, 60), folder: clip(a.folder, 200), file: clip(a.file, 200), link: /^https:\/\/claude\.ai\/[^\s"<>]{1,300}$/.test(String(a.link || "")) ? String(a.link) : "" };
        if (!D.name) return ok({ content: [{ type: "text", text: "Give the design's title." }], isError: true });
        const names: string[] = Array.isArray(box[0].profiles) ? box[0].profiles.filter((x: unknown) => typeof x === "string" && x) : [];
        const active = typeof ctx.active === "string" ? ctx.active : "";
        const staffBy = (ctx.staff && typeof ctx.staff === "object" ? ctx.staff : {}) as Record<string, unknown>;
        const el = caps.elicitation, canAsk = modern && !!el && typeof el === "object" && (!Object.keys(el).length || "form" in el);
        const NOBODY = "Nobody in particular", LATER = "I will choose in the app";
        const resp = p.inputResponses && typeof p.inputResponses === "object" ? (p.inputResponses.details || p.inputResponses.design) : null;
        if (resp) {
          if (resp.action !== "accept") return ok({ content: [{ type: "text", text: "He did not save it. Nothing was added to his Design Studio." }] });
          const c = resp.content && typeof resp.content === "object" ? resp.content : {};
          if (clip(c.name, 140)) D.name = clip(c.name, 140);
          if (DESIGN_TYPES.includes(String(c.type))) D.type = String(c.type);
          if (typeof c.staff === "string") D.staff = c.staff === NOBODY ? "" : clip(c.staff, 80);
          if (names.includes(String(c.profile))) D.profile = String(c.profile);
          if (typeof c.folder === "string") D.folder = c.folder === LATER ? "" : clip(c.folder, 200);
        } else if (!p.inputResponses && canAsk) {
          const prof = names.find(x => x.toLowerCase() === D.profile.toLowerCase()) || active;
          // His folders are asked of his Mac for this one form, shown to him, and kept nowhere.
          let folders: string[] = [];
          if (answers) {
            const made = await (await db("cos_asks", { method: "POST", body: JSON.stringify({ s_hash: sHash, kind: "list_design_folders", args: { profile: prof } }) })).json().catch(() => []);
            const qid = Array.isArray(made) && made[0] && made[0].id;
            if (qid) {
              let answer: any = null;
              for (let i = 0; i < 20 && answer === null; i++) { await new Promise(r => setTimeout(r, 500)); const row = await (await db(`cos_asks?id=eq.${qid}&select=answer`)).json().catch(() => []); if (Array.isArray(row) && row[0] && row[0].answer !== null && row[0].answer !== undefined) answer = row[0].answer; }
              await db(`cos_asks?id=eq.${qid}`, { method: "DELETE" });
              if (answer && typeof answer.text === "string") folders = answer.text.split("\n").map((x: string) => x.trim().slice(0, 200)).filter(Boolean).slice(0, 80);
            }
          }
          let list = Array.isArray(staffBy[prof]) ? (staffBy[prof] as unknown[]) : ([] as unknown[]).concat(...Object.values(staffBy).filter(Array.isArray) as unknown[][]);
          list = [...new Set(list.filter(x => typeof x === "string" && x))].slice(0, 40);
          const props: Record<string, unknown> = { name: { type: "string", title: "Name", default: D.name }, type: { type: "string", title: "Type", enum: DESIGN_TYPES, default: D.type || "Other" } };
          if (list.length) { const cur = (list as string[]).find(x => x.toLowerCase() === D.staff.toLowerCase()); props.staff = { type: "string", title: "Staff member", enum: [...list, NOBODY], default: cur || NOBODY }; }
          if (!prof && names.length > 1) props.profile = { type: "string", title: "Profile", enum: names };
          if (folders.length) { const cur = folders.find(x => x.toLowerCase() === D.folder.toLowerCase()) || folders.find(x => D.folder && x.toLowerCase().endsWith(D.folder.toLowerCase())); props.folder = { type: "string", title: "Folder", enum: [...folders, LATER], default: cur || LATER }; }
          console.log("mcp " + JSON.stringify({ call: "tools/call", step: "design form", fields: Object.keys(props) }));
          return { body: { jsonrpc: "2.0", id: m.id, result: { resultType: "input_required", inputRequests: { details: { method: "elicitation/create", params: { mode: "form", message: "Save this to your Design Studio?", requestedSchema: { type: "object", properties: props, required: ["name", "type"] } } } } } }, status: 200 };
        }
        const sealed = await seal(box[0].pub, JSON.stringify({ at: Date.now(), design: D }));
        const r = await db("cos_relay", { method: "POST", body: JSON.stringify({ s_hash: sHash, sealed }) });
        if (!r.ok) return ok({ content: [{ type: "text", text: "It could not be passed to his app just now. Try again in a moment." }], isError: true });
        return ok({ content: [{ type: "text", text: `Passed to his Chief of Staff app to save as a design called "${D.name}". It appears in the Design Studio within a few seconds if the app is open on his Mac${D.folder ? "" : "; the app asks him which folder"}. Tell him briefly. If his app cannot tell which page it is, it will say so there.` }], structuredContent: { saved: "asked", name: D.name } });
      }
      if (p.name !== "show_for_approval") return err(-32602, "unknown tool", 400);
      const n = KINDS.map(k => a[k]).reduce((t: number, l: unknown) => t + (Array.isArray(l) ? l.length : 0), 0);
      if (!n) return ok({ content: [{ type: "text", text: "Nothing was given to show. Include emails, meetings, changes, actions or documents." }], isError: true });
      // What is still unsettled is asked once, in one small form, where the chat can show one: which profile (unless
      // Claude said, or his app is in a profile already), who an action is for, and who a reply goes to. Whatever he
      // does with the form, the hand-over goes on: anything he leaves, he settles in the app as before.
      const names: string[] = Array.isArray(box[0].profiles) ? box[0].profiles.filter((x: unknown) => typeof x === "string" && x) : [];
      const active = typeof ctx.active === "string" ? ctx.active : "";
      const staffBy = (ctx.staff && typeof ctx.staff === "object" ? ctx.staff : {}) as Record<string, unknown>;
      const el = caps.elicitation;
      const canAsk = modern && !!el && typeof el === "object" && (!Object.keys(el).length || "form" in el);
      const acts: any[] = (Array.isArray(a.actions) ? a.actions : []).filter((x: any) => x && typeof x === "object");
      const loose = acts.filter(x => !String(x.for || "").trim());
      const replies: any[] = (Array.isArray(a.emails) ? a.emails : []).filter((e: any) => e && typeof e === "object" && e.reply_to && typeof e.reply_all !== "boolean");
      const LATER = "I will choose in the app", SENDER = "Just the sender", EVERYONE = "Everyone on the email";
      const resp = p.inputResponses && typeof p.inputResponses === "object" ? (p.inputResponses.details || p.inputResponses.account) : null;
      if (resp) {
        console.log("mcp " + JSON.stringify({ call: "tools/call", step: "answer to the questions", action: String(resp.action || "").slice(0, 12) }));
        const c = resp.action === "accept" && resp.content && typeof resp.content === "object" ? resp.content : {};
        if (names.includes(String(c.account))) a.for_account = String(c.account);
        if (typeof c.staff === "string" && c.staff && c.staff !== LATER) for (const x of loose) x.for = c.staff.slice(0, 80);
        if (typeof c.reply === "string") for (const e of replies) e.reply_all = c.reply === EVERYONE;
      } else if (!p.inputResponses && canAsk) {
        const props: Record<string, unknown> = {}, asks: string[] = [];
        if (!String(a.for_account || "").trim() && names.length > 1 && !active) { props.account = { type: "string", title: "Profile", description: "Which mailbox and calendar it goes into", enum: names }; asks.push("profile"); }
        if (loose.length) {
          const prof = names.find(x => x.toLowerCase() === String(a.for_account || "").trim().toLowerCase()) || active;
          let list = Array.isArray(staffBy[prof]) ? (staffBy[prof] as unknown[]) : ([] as unknown[]).concat(...Object.values(staffBy).filter(Array.isArray) as unknown[][]);
          list = [...new Set(list.filter(x => typeof x === "string" && x))].slice(0, 40);
          if (list.length > 1) { props.staff = { type: "string", title: loose.length === 1 ? "Who is the action for" : `Who are these ${loose.length} actions for`, enum: [...list, LATER] }; asks.push("staff"); }
        }
        if (replies.length) { props.reply = { type: "string", title: replies.length === 1 ? "Reply to" : "Replies go to", enum: [SENDER, EVERYONE] }; asks.push("reply"); }
        if (asks.length) {
          console.log("mcp " + JSON.stringify({ call: "tools/call", step: "asked", about: asks }));
          return { body: { jsonrpc: "2.0", id: m.id, result: { resultType: "input_required", inputRequests: { details: { method: "elicitation/create", params: { mode: "form", message: asks.length === 1 && asks[0] === "profile" ? "Which of your profiles is this for? It decides which mailbox and calendar it goes into." : "A couple of things to settle before this goes to your app. Leave any of them and you can choose in the app.", requestedSchema: { type: "object", properties: props, required: asks.length === 1 && asks[0] === "profile" ? ["account"] : [] } } } } } }, status: 200 };
        }
      }
      const ref = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
      const state: Record<string, string[]> = {}; for (const k of KINDS) { const c = Array.isArray(a[k]) ? a[k].length : 0; if (c) state[k] = Array(Math.min(c, 100)).fill("waiting"); }
      const sealed = await seal(box[0].pub, JSON.stringify({ at: Date.now(), ref, summary: String(a.summary || "").slice(0, 300), for_account: String(a.for_account || "").slice(0, 120), emails: a.emails || [], meetings: a.meetings || [], changes: a.changes || [], actions: a.actions || [], documents: a.documents || [] }));
      // a box never holds more than a handful, and nothing older than two days; what he did is kept a week
      await db(`cos_relay?s_hash=eq.${sHash}&created_at=lt.${new Date(Date.now() - 2 * 864e5).toISOString()}`, { method: "DELETE" });
      await db(`cos_outcomes?s_hash=eq.${sHash}&created_at=lt.${new Date(Date.now() - 7 * 864e5).toISOString()}`, { method: "DELETE" });
      const have = await (await db(`cos_relay?s_hash=eq.${sHash}&select=id`)).json().catch(() => []);
      if (Array.isArray(have) && have.length >= 40) return ok({ content: [{ type: "text", text: "His app has not collected the earlier ones yet. Ask him to open the Chief of Staff app on his Mac, then try again." }], isError: true });
      const r = await db("cos_relay", { method: "POST", body: JSON.stringify({ s_hash: sHash, sealed }) });
      if (!r.ok) return ok({ content: [{ type: "text", text: "It could not be handed to the app just now. Try again in a moment." }], isError: true });
      await db("cos_outcomes", { method: "POST", body: JSON.stringify({ s_hash: sHash, ref, state }) }).catch(() => null);
      return ok({ content: [{ type: "text", text: `Handed to his Chief of Staff app: ${n} item${n === 1 ? "" : "s"} are waiting there for him to check and approve. Nothing has been sent, created or changed yet. Tell him briefly that it is waiting in the app (it shows within a few seconds if the app is open on his Mac). Do not also make these changes with any other tool. Reference ${ref}: use check_outcome with it to see what he did, before you say anything was done.` }], structuredContent: { ref, state, ...(ctx.edits ? { pick: { profiles: names, staff: staffBy, active, account: String(a.for_account || "") } } : {}) } });
    }
    return err(-32601, "method not found", 404);
  };
  if (Array.isArray(msg)) { const out = (await Promise.all(msg.map(x => one(x, false)))).filter(Boolean) as { body: unknown }[]; return out.length ? json(out.map(o => o.body)) : new Response(null, { status: 202 }); }
  const out = await one(msg, true); return out ? json(out.body, out.status) : new Response(null, { status: 202 });
}

async function app(req: Request, what: string) {
  if (req.method !== "POST") return json({ error: "post only" }, 405);
  const body = await req.json().catch(() => ({}));
  if (what === "register") {
    if (!okHash(body.s_hash) || !okHash(body.t_hash) || typeof body.pub !== "string" || body.pub.length > 200) return json({ error: "bad request" }, 400);
    const all = await (await db("cos_boxes?select=s_hash")).json().catch(() => []);
    if (Array.isArray(all) && all.length >= 2) return json({ error: "This connector is already set up for another Mac." }, 403);         // sign-up is closed once it is in use
    const r = await db("cos_boxes", { method: "POST", body: JSON.stringify({ s_hash: body.s_hash, t_hash: body.t_hash, pub: body.pub }) });
    return r.ok ? json({ ok: true }) : json({ error: "could not register" }, 400);
  }
  const tHash = await sha(String(req.headers.get("x-cos-token") || ""));
  const box = await (await db(`cos_boxes?t_hash=eq.${tHash}&select=s_hash`)).json().catch(() => []);
  if (!Array.isArray(box) || !box.length) return json({ error: "not known" }, 401);
  const s = box[0].s_hash;
  if (what === "pull") {
    const rows = await (await db(`cos_relay?s_hash=eq.${s}&select=id,sealed,created_at&order=created_at.asc&limit=20`)).json().catch(() => []);
    // (buttons pressed in the chat panel: handed over once, then gone)
    const cmds = await (await db(`cos_cmds?s_hash=eq.${s}&select=id,ref,kind,idx,act,data&order=created_at.asc&limit=20`)).json().catch(() => []);
    const list = Array.isArray(cmds) ? cmds : [];
    if (list.length) await db(`cos_cmds?s_hash=eq.${s}&id=in.(${list.map((c: any) => c.id).join(",")})`, { method: "DELETE" });
    // (questions waiting for this Mac: each is handed out once)
    const asks = await (await db(`cos_asks?s_hash=eq.${s}&taken=eq.false&select=id,kind,args&order=created_at.asc&limit=10`)).json().catch(() => []);
    const qs = Array.isArray(asks) ? asks : [];
    if (qs.length) await db(`cos_asks?s_hash=eq.${s}&id=in.(${qs.map((q: any) => q.id).join(",")})`, { method: "PATCH", body: JSON.stringify({ taken: true }) });
    return json({ ok: true, rows: Array.isArray(rows) ? rows : [], cmds: list.map((c: any) => ({ ref: c.ref, kind: c.kind, index: c.idx, act: c.act, data: c.data || null })), asks: qs.map((q: any) => ({ id: q.id, kind: q.kind, args: q.args || {} })) });
  }
  if (what === "ack") { const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x: unknown) => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x as string)).slice(0, 40); if (ids.length) await db(`cos_relay?s_hash=eq.${s}&id=in.(${ids.join(",")})`, { method: "DELETE" }); return json({ ok: true }); }
  // The names of his profiles (names only), so Claude can offer them as choices. An empty list turns the question off.
  // Also: which profile his app is in now (so he is not asked when he is plainly in one), the titles of his staff in
  // each profile (to offer when an action has nobody named), and whether he wants the panel in the chat. Names only.
  if (what === "profiles") {
    const clean = (l: unknown, max: number) => (Array.isArray(l) ? l : []).filter((x: unknown) => typeof x === "string").map((x: string) => x.trim().slice(0, 60)).filter(Boolean).slice(0, max);
    const names = clean(body.names, 20), staff: Record<string, string[]> = {};
    if (body.staff && typeof body.staff === "object") for (const k of Object.keys(body.staff).slice(0, 20)) if (names.includes(k)) staff[k] = clean(body.staff[k], 40);
    const ctx = { active: typeof body.active === "string" && names.includes(body.active.trim()) ? body.active.trim() : "", staff, panel: body.panel !== false, answers: body.answers === true, edits: typeof body.answers === "boolean", studio: body.studio === true };
    const r = await db(`cos_boxes?s_hash=eq.${s}`, { method: "PATCH", body: JSON.stringify({ profiles: names, ctx }) });
    return r.ok ? json({ ok: true, count: names.length }) : json({ error: "could not keep them" }, 400);
  }
  // The Mac's answer to a question. It is read once by the call that is waiting for it, then wiped.
  if (what === "answer") {
    if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/.test(body.id)) return json({ error: "bad request" }, 400);
    const r = await db(`cos_asks?s_hash=eq.${s}&id=eq.${body.id}`, { method: "PATCH", body: JSON.stringify({ answer: { text: String(body.text || "").slice(0, 6000) } }) });
    return r.ok ? json({ ok: true }) : json({ error: "could not keep it" }, 400);
  }
  // What he did with a hand-over: the state of each item by its place, nothing else.
  if (what === "outcome") {
    if (typeof body.ref !== "string" || !/^[0-9a-f]{10}$/.test(body.ref) || !body.state || typeof body.state !== "object") return json({ error: "bad request" }, 400);
    const OKS = ["waiting", "opened", "done", "added", "made", "dismissed", "failed"], state: Record<string, string[]> = {};
    for (const k of ["emails", "meetings", "changes", "actions", "documents"]) if (Array.isArray(body.state[k])) state[k] = body.state[k].slice(0, 100).map((v: unknown) => (OKS.includes(String(v)) ? String(v) : "waiting"));
    const r = await db(`cos_outcomes?s_hash=eq.${s}&ref=eq.${body.ref}`, { method: "PATCH", body: JSON.stringify({ state, updated_at: new Date().toISOString() }) });
    return r.ok ? json({ ok: true }) : json({ error: "could not keep it" }, 400);
  }
  if (what === "rotate") {                                              // a new address and key for the same app; the old address stops at once
    if (!okHash(body.s_hash) || !okHash(body.t_hash) || typeof body.pub !== "string" || body.pub.length > 200) return json({ error: "bad request" }, 400);
    const was = await (await db(`cos_boxes?s_hash=eq.${s}&select=profiles,ctx`)).json().catch(() => []);
    await db(`cos_boxes?s_hash=eq.${s}`, { method: "DELETE" }); await db(`cos_outcomes?s_hash=eq.${s}`, { method: "DELETE" }); await db(`cos_cmds?s_hash=eq.${s}`, { method: "DELETE" }); await db(`cos_asks?s_hash=eq.${s}`, { method: "DELETE" });
    const r = await db("cos_boxes", { method: "POST", body: JSON.stringify({ s_hash: body.s_hash, t_hash: body.t_hash, pub: body.pub, profiles: (Array.isArray(was) && was[0] && was[0].profiles) || [], ctx: (Array.isArray(was) && was[0] && was[0].ctx) || {} }) });
    return r.ok ? json({ ok: true }) : json({ error: "could not change it" }, 400);
  }
  if (what === "unregister") { await db(`cos_boxes?s_hash=eq.${s}`, { method: "DELETE" }); await db(`cos_outcomes?s_hash=eq.${s}`, { method: "DELETE" }); return json({ ok: true }); }
  return json({ error: "not found" }, 404);
}

Deno.serve(async (req: Request) => {
  try {
    const parts = new URL(req.url).pathname.split("/").filter(Boolean), i = parts.indexOf("cos-connector"), rest = parts.slice(i + 1);
    if (rest[0] === "mcp" && rest[1] && rest[1].length >= 32) return await mcp(req, rest[1]);
    if (rest[0] === "app" && rest[1]) return await app(req, rest[1]);
    return json({ error: "not found" }, 404);
  } catch (_e) { return json({ error: "something went wrong" }, 500); }
});

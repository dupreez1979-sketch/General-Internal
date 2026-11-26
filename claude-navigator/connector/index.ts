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
      emails: { type: "array", description: "Emails for him to check and send himself. No signature (his mail app adds it).", items: { type: "object", properties: { to: { type: "string", description: "Addresses or names, separated by commas" }, cc: { type: "string" }, subject: { type: "string" }, body: { type: "string", description: "Plain text, blank lines between paragraphs. For a reply, only the new words: the app adds the earlier emails underneath." }, reply_to: { type: "object", description: "Give this whenever the email answers one he received, so it opens as a reply in that conversation with the history underneath. Describe the email being answered.", properties: { subject: { type: "string", description: "Its subject, exactly" }, from: { type: "string", description: "Who sent it: name or address" }, sent: { type: "string", description: "When it was sent, YYYY-MM-DD, if known" } }, required: ["subject"] }, reply_all: { type: "boolean", description: "true to answer everyone on the email, false for the sender only" } }, required: ["subject", "body"] } },
      meetings: { type: "array", description: "Meetings with other people. Each opens as an invitation for him to check and save; nobody is told until he does.", items: { type: "object", properties: { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, start: { type: "string", description: "HH:MM, 24 hour, his local time" }, end: { type: "string", description: "HH:MM" }, where: { type: "string" }, teams: { type: "boolean", description: "true if online" }, invite: { type: "string", description: "Email addresses when known for certain, otherwise names exactly, separated by semicolons. Never guess an address." }, purpose: { type: "string" }, agenda: { type: "string", description: "Items separated by semicolons, minutes in brackets if said" }, before: { type: "string", description: "What to read or bring, separated by semicolons" }, notes: { type: "string" }, check: { type: "string", description: "Anything you assumed, shown only to him" } }, required: ["title"] } },
      actions: { type: "array", description: "Actions (to-dos) to add to the list of one of his staff members in the app.", items: { type: "object", properties: { for: { type: "string", description: "The staff member's title, for example \"Finance Officer\". Leave out if unsure and he chooses." }, action: { type: "string", description: "The action in one short line, starting with a verb" }, why: { type: "string", description: "One line of background" } }, required: ["action"] } },
      documents: { type: "array", description: "Documents to save as Word files in one of his company folders (he chooses the folder).", items: { type: "object", properties: { title: { type: "string" }, text: { type: "string", description: "The whole text, plain, with a blank line between paragraphs" } }, required: ["title", "text"] } },
      changes: { type: "array", description: "Entries in his own calendar with nobody invited, and mail rules and folders. " + CHANGE_HELP, items: { type: "object", properties: { do: { type: "string", enum: ["add_event", "remove_event", "change_event", "add_rule", "add_folder"] } }, required: ["do"], additionalProperties: true } },
    },
    required: ["summary"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}];

// ---------- The protocol ----------
// Two eras are spoken at once. The older one opens with an "initialize" handshake. The newer one (2026-07-28) has no
// handshake: every request says which version it speaks, in its _meta and in a header, and is answered by itself.
// A request is treated as the newer kind when it carries that version in its _meta; anything else is the older kind.
const MODERN = ["2026-07-28"], LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PV = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO = { name: "chief-of-staff-app", title: "Chief of Staff app", version: "1.1.0" };
const INSTRUCTIONS = "Use show_for_approval to hand emails, meetings and calendar or mail changes to the user's app, where he approves them. It never sends or changes anything by itself.";
// Only Claude's own pages may call this from a browser (a request from Claude's servers carries no Origin at all).
const originOk = (o: string | null) => { if (!o) return true; try { const h = new URL(o).hostname.toLowerCase(); return ["claude.ai", "claude.com", "anthropic.com"].some(d => h === d || h.endsWith("." + d)); } catch { return false; } };

type Ans = { body: unknown; status: number } | null;
async function mcp(req: Request, secret: string) {
  if (!originOk(req.headers.get("origin"))) return json({ jsonrpc: "2.0", error: { code: -32600, message: "origin not allowed" } }, 403);
  const sHash = await sha(secret);
  const box = await (await db(`cos_boxes?s_hash=eq.${sHash}&select=pub`)).json().catch(() => []);
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
        if (hn !== null && m.method === "tools/call" && hn !== String(p.name || "")) return err(-32020, "The Mcp-Name header does not match the request", 400);
      }
    }
    if (m.method === "initialize") return ok({ protocolVersion: LEGACY.includes(p.protocolVersion) ? p.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    // Who this is and what it speaks. Answered whether or not the caller has said its version yet (this is how it finds out).
    if (m.method === "server/discover") return { body: { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", supportedVersions: MODERN.concat(LEGACY), capabilities: { tools: {} }, instructions: INSTRUCTIONS, ttlMs: 3600000, cacheScope: "private", _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } } }, status: 200 };
    if (m.method === "ping") return ok({});
    if (m.method === "tools/list") return ok(modern ? { tools: TOOLS, ttlMs: 300000, cacheScope: "private" } : { tools: TOOLS });
    if (m.method === "tools/call") {
      const a = p.arguments || {};
      if (p.name !== "show_for_approval") return err(-32602, "unknown tool", 400);
      const n = [a.emails, a.meetings, a.changes, a.actions, a.documents].reduce((t: number, l: unknown) => t + (Array.isArray(l) ? l.length : 0), 0);
      if (!n) return ok({ content: [{ type: "text", text: "Nothing was given to show. Include emails, meetings, changes, actions or documents." }], isError: true });
      const sealed = await seal(box[0].pub, JSON.stringify({ at: Date.now(), summary: String(a.summary || "").slice(0, 300), for_account: String(a.for_account || "").slice(0, 120), emails: a.emails || [], meetings: a.meetings || [], changes: a.changes || [], actions: a.actions || [], documents: a.documents || [] }));
      // a box never holds more than a handful, and nothing older than two days
      await db(`cos_relay?s_hash=eq.${sHash}&created_at=lt.${new Date(Date.now() - 2 * 864e5).toISOString()}`, { method: "DELETE" });
      const have = await (await db(`cos_relay?s_hash=eq.${sHash}&select=id`)).json().catch(() => []);
      if (Array.isArray(have) && have.length >= 40) return ok({ content: [{ type: "text", text: "His app has not collected the earlier ones yet. Ask him to open the Chief of Staff app on his Mac, then try again." }], isError: true });
      const r = await db("cos_relay", { method: "POST", body: JSON.stringify({ s_hash: sHash, sealed }) });
      if (!r.ok) return ok({ content: [{ type: "text", text: "It could not be handed to the app just now. Try again in a moment." }], isError: true });
      return ok({ content: [{ type: "text", text: `Handed to his Chief of Staff app: ${n} item${n === 1 ? "" : "s"} are waiting there for him to check and approve. Nothing has been sent, created or changed yet, and you cannot see whether he approves. Tell him briefly that it is waiting in the app (it shows within a few seconds if the app is open on his Mac). Do not also make these changes with any other tool.` }] });
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
  if (what === "pull") { const rows = await (await db(`cos_relay?s_hash=eq.${s}&select=id,sealed,created_at&order=created_at.asc&limit=20`)).json().catch(() => []); return json({ ok: true, rows: Array.isArray(rows) ? rows : [] }); }
  if (what === "ack") { const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x: unknown) => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x as string)).slice(0, 40); if (ids.length) await db(`cos_relay?s_hash=eq.${s}&id=in.(${ids.join(",")})`, { method: "DELETE" }); return json({ ok: true }); }
  if (what === "rotate") {                                              // a new address and key for the same app; the old address stops at once
    if (!okHash(body.s_hash) || !okHash(body.t_hash) || typeof body.pub !== "string" || body.pub.length > 200) return json({ error: "bad request" }, 400);
    await db(`cos_boxes?s_hash=eq.${s}`, { method: "DELETE" });
    const r = await db("cos_boxes", { method: "POST", body: JSON.stringify({ s_hash: body.s_hash, t_hash: body.t_hash, pub: body.pub }) });
    return r.ok ? json({ ok: true }) : json({ error: "could not change it" }, 400);
  }
  if (what === "unregister") { await db(`cos_boxes?s_hash=eq.${s}`, { method: "DELETE" }); return json({ ok: true }); }
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

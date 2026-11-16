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
  description: "Hand emails, meetings and calendar or mail changes to the user's Chief of Staff app on his Mac, where they appear for him to check and approve. Use this whenever he asks you to put something in his calendar, set up or change calendar entries, draft or send an email, set up a meeting or invitation, or make a mail rule or folder. Prefer this over any other calendar or email tool for making or changing things. Nothing is sent, created or changed by this call: he approves each item in the app, and he sends every email and invitation himself. Put everything from one request into a single call. Never use em dashes in the text you write.",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One short line saying what this is, shown as the heading." },
      for_account: { type: "string", description: "Which of his organisations or email accounts this belongs to, in his own words or as an email address (for example \"Monkey Baa\" or \"Consulting\"), when the chat makes it clear. Leave out if unsure." },
      emails: { type: "array", description: "Emails for him to check and send himself. No signature (his mail app adds it).", items: { type: "object", properties: { to: { type: "string", description: "Addresses or names, separated by commas" }, cc: { type: "string" }, subject: { type: "string" }, body: { type: "string", description: "Plain text, blank lines between paragraphs" } }, required: ["subject", "body"] } },
      meetings: { type: "array", description: "Meetings with other people. Each opens as an invitation for him to check and save; nobody is told until he does.", items: { type: "object", properties: { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, start: { type: "string", description: "HH:MM, 24 hour, his local time" }, end: { type: "string", description: "HH:MM" }, where: { type: "string" }, teams: { type: "boolean", description: "true if online" }, invite: { type: "string", description: "Email addresses when known for certain, otherwise names exactly, separated by semicolons. Never guess an address." }, purpose: { type: "string" }, agenda: { type: "string", description: "Items separated by semicolons, minutes in brackets if said" }, before: { type: "string", description: "What to read or bring, separated by semicolons" }, notes: { type: "string" }, check: { type: "string", description: "Anything you assumed, shown only to him" } }, required: ["title"] } },
      changes: { type: "array", description: "Entries in his own calendar with nobody invited, and mail rules and folders. " + CHANGE_HELP, items: { type: "object", properties: { do: { type: "string", enum: ["add_event", "remove_event", "change_event", "add_rule", "add_folder"] } }, required: ["do"], additionalProperties: true } },
    },
    required: ["summary"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}];

async function mcp(req: Request, secret: string) {
  const sHash = await sha(secret);
  const box = await (await db(`cos_boxes?s_hash=eq.${sHash}&select=pub`)).json().catch(() => []);
  if (!Array.isArray(box) || !box.length) return json({ error: "not found" }, 404);
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const raw = await req.text(); if (raw.length > 400_000) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "too large" } }, 413);
  let msg: any; try { msg = JSON.parse(raw); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
  const one = async (m: any) => {
    if (!m || m.id === undefined || m.id === null) return null;                                   // a notification: nothing to answer
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    if (m.method === "initialize") return ok({ protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "chief-of-staff-app", title: "Chief of Staff app", version: "1.0.0" }, instructions: "Use show_for_approval to hand emails, meetings and calendar or mail changes to the user's app, where he approves them. It never sends or changes anything by itself." });
    if (m.method === "ping") return ok({});
    if (m.method === "tools/list") return ok({ tools: TOOLS });
    if (m.method === "tools/call") {
      const p = m.params || {}, a = p.arguments || {};
      if (p.name !== "show_for_approval") return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "unknown tool" } };
      const n = (Array.isArray(a.emails) ? a.emails.length : 0) + (Array.isArray(a.meetings) ? a.meetings.length : 0) + (Array.isArray(a.changes) ? a.changes.length : 0);
      if (!n) return ok({ content: [{ type: "text", text: "Nothing was given to show. Include emails, meetings or changes." }], isError: true });
      const sealed = await seal(box[0].pub, JSON.stringify({ at: Date.now(), summary: String(a.summary || "").slice(0, 300), for_account: String(a.for_account || "").slice(0, 120), emails: a.emails || [], meetings: a.meetings || [], changes: a.changes || [] }));
      // a box never holds more than a handful, and nothing older than two days
      await db(`cos_relay?s_hash=eq.${sHash}&created_at=lt.${new Date(Date.now() - 2 * 864e5).toISOString()}`, { method: "DELETE" });
      const have = await (await db(`cos_relay?s_hash=eq.${sHash}&select=id`)).json().catch(() => []);
      if (Array.isArray(have) && have.length >= 40) return ok({ content: [{ type: "text", text: "His app has not collected the earlier ones yet. Ask him to open the Chief of Staff app on his Mac, then try again." }], isError: true });
      const r = await db("cos_relay", { method: "POST", body: JSON.stringify({ s_hash: sHash, sealed }) });
      if (!r.ok) return ok({ content: [{ type: "text", text: "It could not be handed to the app just now. Try again in a moment." }], isError: true });
      return ok({ content: [{ type: "text", text: `Handed to his Chief of Staff app: ${n} item${n === 1 ? "" : "s"} are waiting there for him to check and approve. Nothing has been sent, created or changed yet, and you cannot see whether he approves. Tell him briefly that it is waiting in the app (it shows within a few seconds if the app is open on his Mac). Do not also make these changes with any other tool.` }] });
    }
    return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
  };
  if (Array.isArray(msg)) { const out = (await Promise.all(msg.map(one))).filter(Boolean); return out.length ? json(out) : new Response(null, { status: 202 }); }
  const out = await one(msg); return out ? json(out) : new Response(null, { status: 202 });
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

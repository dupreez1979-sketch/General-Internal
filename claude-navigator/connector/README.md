# The Claude Connector (relay)

Lets Claude, in any chat on claude.ai, hand work to this app for approval: emails, meetings, calendar and mail
changes, actions for staff, and documents. Nothing is sent or changed by the relay. The app shows what arrives under
"From Claude", and each item happens only when it is approved there.

## How it fits together

1. In the app: Settings, Claude Connector, Turn On. The app makes a key pair and an address, and registers with the relay.
2. In Claude: Settings, Connectors, Add custom connector, paste the address, no sign-in.
3. Claude calls the one tool, `show_for_approval`. The relay locks what it is given with the app's public key and holds it.
4. The app collects it within a few seconds (once a minute when it is not in front), keeps it on the Mac, and the
   relay's copy is deleted. Uncollected items are dropped after two days.

## What the relay can and cannot do

- It cannot read what it holds: only the Mac has the private key (kept encrypted by the Keychain).
- It has no access to any mailbox or calendar, and holds no Microsoft sign-in.
- Anyone with the address could put suggestions on the approval card. They could not read or change anything.
  Settings, Claude Connector, New Address replaces the address at once.
- Sign-up closes after two apps have registered.

The rules about what an approved change may do (never send, never invite, never forward, never delete permanently)
are enforced in the app (`graphAi` in `accounts.js`), not here.

## Where it runs

A Supabase project, as the edge function `cos-connector` (JWT check off: it does its own checks), with two tables,
`cos_boxes` (registered apps: hashes and a public key) and `cos_relay` (locked items waiting). Row level security is
on with no policies, so only the function can touch them. The app's address for it is `connBase()` in `main.js`.

## Changing it

Edit `index.ts` and deploy it again as `cos-connector`. Changes to the tool's description or fields take effect at
once for the app. Claude keeps the old description until the connector is disconnected and added again.

## Which version of the connector standard it speaks

Both, at once. Nothing has to be set.

- **The older style** (versions up to 2025-11-25): opens with an `initialize` handshake. Answers are exactly as before.
- **The newer style** (2026-07-28): no handshake. Each request names its version in its `_meta` and in a header, and is
  answered by itself. The relay answers `server/discover` (who it is and which versions it speaks), marks every answer
  `resultType: "complete"`, and says how long the tool list may be kept.

A request counts as the newer style when it carries `io.modelcontextprotocol/protocolVersion` in its `_meta`.

What it refuses, in the newer style: a version it does not speak (it lists the ones it does), and a request whose
`MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` header says something different from the request itself. A header
that is simply absent is let through, so that a slightly different client is not locked out.

In both styles it refuses a browser request from any site other than Claude's own (`Origin` check). A request from
Claude's servers carries no `Origin` and is unaffected.

Not built: file upload (Claude only passes files to connectors in its public directory).

## The one thing it knows about you: profile names

So that Claude can ask "which profile is this for?" with a list to pick from, the app gives the relay the names of
your profiles (for example "NCTI"), and nothing else about them. They are kept in the `profiles` column of
`cos_boxes`. The question is asked only when all of these hold: the chat speaks the newer style and says it can show
a form, Claude did not name an account, and there is more than one profile. Whatever the answer (or none), the
hand-over still goes through; without an answer you choose the profile in the app, as before.

Turning off "Claude Asks Which Profile" in the app's settings empties the list on the relay.

The relay also writes one line per call to the function's log with the call's name (for example `skills/list`) and
what the caller says it supports. Never any content.

## The skill it carries

In the newer style the relay also offers one skill, `chief-of-staff-app`: a single page of plain words telling Claude
how to use `show_for_approval` well (which kind of item to use, how to describe a reply, time zones, never giving ids,
which account). It is the `SKILL_MD` text in `index.ts`. There are no scripts and no other files.

It is advertised in `server/discover` (`resources` and the `io.modelcontextprotocol/skills` extension) and served by
`skills/list`, `skills/get` and `resources/read`. Its fingerprint (digest) is worked out from the words actually
served, so changing the text and redeploying is all an update takes. Claude may ask the user to approve the skill
again after a change.

This part of the standard is in beta. It is offered only in the newer style; the older style is unchanged.

## Small questions the Mac answers (1.7.0)

Three read-only tools let Claude ask the app something only the Mac knows: `lookup_address` (a person's email
address by name), `find_free_time` (free stretches only, never titles or people) and `list_staff`. The question is
left in `cos_asks`, the app collects it on its next pull, answers through `app/answer`, and the waiting call passes
the answer on and wipes the row. If the app is shut the call says so after about 25 seconds. The user can turn this
off in the app, which also removes the three tools from the list.

## Editing in the panel (1.7.0)

`act_on_item` also takes `do: "amend"` with a `set` of short named fields (an email's to, cc and subject; a meeting's
title, date and times; who an action is for; the profile of the whole hand-over). The body of an email can never be
changed this way. The panel tells Claude what the user did through `ui/update-model-context`, so nothing is typed
into the chat.

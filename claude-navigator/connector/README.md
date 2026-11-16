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

# Mirkwood (Myrkviðr)

A cooperative, online, 4-player tile-placement game of Viking souls lost in the
mist-forest Myrkviðr, seeking the gates of Valhalla and Fólkvangr. Inspired by
*The Night Cage* (Smirk & Dagger) — Mirkwood's own rules text and all design
departures are in [RULES.md](RULES.md).

Runs on **Cloudflare Workers**: static assets + one Durable Object per game
room (SQLite-backed, works on the free plan). Games persist in DO storage, so
a dropped connection or closed laptop doesn't kill the saga.

## Local development

```
npm install
npm run dev        # wrangler dev → http://localhost:8930
npm test           # engine test suite + 200-game random self-play
```

## Deploying to Cloudflare

### Option A — dashboard only, no CLI (recommended)

Connect the repo once; every `git push` to main deploys automatically
(Cloudflare's build system runs wrangler for you — you never install it):

1. Push this folder to a GitHub repository (private is fine; `.gitignore`
   already excludes node_modules, `.wrangler/`, and any credentials).
2. **dash.cloudflare.com** → *Workers & Pages* → **Create** → *Workers* →
   **Import a repository** (connect/authorize GitHub the first time) →
   select the repo.
3. Build configuration: leave the defaults — no build command needed; deploy
   command `npx wrangler deploy` (it reads [wrangler.jsonc](wrangler.jsonc):
   the Durable Object migration, static assets, everything).
4. **Deploy.** The first deploy registers the `MirkwoodRoom` Durable Object
   and prints your `https://mirkwood.<subdomain>.workers.dev` URL.
5. From then on: commit to main → push → it's live in ~1 minute. The
   *Deployments* tab shows history and one-click rollback; pushes to other
   branches get preview URLs.

Optional: *Settings → Domains & Routes* to attach a custom domain.

### Option B — CLI

```
npx wrangler login
npm run deploy
```

### Secrets in the dashboard

*Workers & Pages → mirkwood → Settings → Variables and Secrets → Add* —
choose type **Secret**, then `FIREBASE_PROJECT_ID` and
`FIREBASE_SERVICE_ACCOUNT` (paste the whole JSON as the value; multi-line is
fine). Secrets set here persist across git deploys and are encrypted and
write-only. This is the full telemetry setup — no CLI involved.

Add `VAPID_JWK` the same way to switch on notifications for a **closed** app
(see below). Every secret is optional: unset simply means that feature is off.

### Turn notifications

Two tiers, both opt-in behind the topbar bell (Mirkwood never asks for
notification permission on its own — only a bell click does):

- **Local** (always available, no setup): the page rings itself. Needs its JS
  to be *running*, so this tier only exists while the app is on screen or (on
  desktop and for a few minutes on Android) merely hidden.
- **Push** (needs `VAPID_JWK`): the Worker asks the browser's push service to
  ring you. Reaches an installed app that is backgrounded **or** fully closed.

They divide on one question: **is anyone watching?** Not "is the socket open" —
that was the original mistake, and it cost a whole class of missed turns.
Backgrounding an installed app freezes the page (suspending even its WebSocket
message handler, within about five seconds on iOS) but leaves the socket open,
because the browser does not close it for you. Such a player looked connected
while being completely unable to ring themselves, so both tiers stayed quiet.

So the client says `{t:'away'}` when it goes to the background, and the Worker
counts a socket as watching only while its page says it is on screen. Closed,
backgrounded and frozen all collapse to the same answer, and the Worker pushes.
The flag rides along with the token on join (a page can reconnect while still
pocketed), and if it is ever lost to a freeze, the Worker asks again the moment
the socket is reaped — so a decision rings late rather than never.

Only one tier ever fires: the Worker publishes `pushArmed` on the room view, and
the page's own bell stands down whenever the Worker will ring instead. That
answer is deliberately the Worker's rather than the client's guess, because the
two must agree exactly: a wrong "no" is a silent miss, and a wrong "yes" is a
double notification — and on iOS a double really is two notifications and two
buzzes, since Safari ignores the `tag` that collapses them elsewhere.

To enable push:

1. `node tools/vapid-keys.mjs` — prints one JSON line (no npm install, no CLI).
2. Paste it as the secret **`VAPID_JWK`** (dashboard, type Secret, as above).
   Optionally set `VAPID_SUBJECT` to a contact URL; it defaults to the address
   already in the privacy notice.
3. Open `/push-test` to confirm the runtime sees it and the key parses.

**Why didn't my phone ring?** Open **`/push-status?room=CODE`** (the saga's
4-letter code). For each soul it reports `connected` **and** `watching` — the
distinction is the whole point, since `connected: true, watching: false` is a
backgrounded app whose page is frozen, and that is precisely the state the
Worker used to misread as "someone is looking at it". It also reports
`subscribedDevices` (`0` = the bell was never enabled in this saga) and
`lastPush`: what was said, how many devices the push service accepted, and any
failure. `lastPush: null` means no push was ever attempted. Subscription
endpoints and keys are never exposed.

Prefer this over the dashboard logs: Mirkwood runs everything inside WebSocket
handlers, and **`console.log` from a WebSocket handler is held back from the
dashboard's live log view until the socket closes** — so a live tail looks
empty exactly when you most want to read it. If you do want the logs, they are
under *Workers & Pages → mirkwood → **Observability*** (not "Logs"), persisted
for 7 days; every push traces there either way.

Notes:
- The public application-server key is *derived* from that secret and served
  from `/push-key`, so the client's key can never drift from the signing key.
  Nothing key-shaped lives in the repo.
- Payloads are encrypted end-to-end (RFC 8291): the push service relays
  ciphertext it cannot read. The crypto is pinned against the RFC's own test
  vector in `test/push.test.js`.
- Subscriptions live in the room's Durable Object and are dropped when the
  player switches the bell off, leaves, or the room purges — and when the
  push service reports one as expired.
- Rotating the key is safe: subscriptions made against the old key are traded
  in automatically the next time that player joins.
- **iOS**: push reaches an *installed* PWA only (Add to Home Screen, 16.4+).
  A real device is the only way to confirm delivery. iOS also **ignores**
  `icon`, `badge` and `tag`: it always draws the app's own Home Screen icon,
  which it captures at install time and never refetches. So an iOS notification
  showing a blank/white icon means the *installed* icon is the placeholder iOS
  captured before `apple-touch-icon.png` existed — no deploy can fix that, the
  app has to be removed and re-added.

### Icons (`tools/mk-icons.py`)

Two kinds of asset, and the difference is not cosmetic:

- **App icons** (`icon-192`, `icon-512`, `apple-touch-icon`) are **opaque**.
  Apple requires it; alpha in a Home Screen icon gets composited against a
  solid fill, which is how logos end up white-on-white.
- **`badge-96.png` is the opposite: nothing but alpha.** Android draws the
  notification's status-bar small icon from the **alpha channel alone**,
  discards RGB, and fills the mask with flat white. Hand it an app icon and
  every pixel is opaque, so the mask is the whole square and you get a **solid
  white blob** — the documented result of the wrong kind of image, not a
  degraded one. It carries no ember glow either: a soft alpha gradient masks
  into a grey smear.

One file cannot serve both. If a silhouette is ever unavailable, **omit
`badge:` entirely** rather than pass an app icon — Chrome then falls back to
its own properly-masked logo, which is strictly better than a white square.
`badge` is Chrome-on-Android only; it is inert (but harmless) on iOS.

Notes:
- The `migrations` block in [wrangler.jsonc](wrangler.jsonc) declares the
  `MirkwoodRoom` Durable Object as SQLite-backed — required for the free plan.
- Rooms self-purge 24 hours after the last activity (DO alarm).
- Reconnects: the browser keeps a token in localStorage and rejoins its seats
  automatically — refresh mid-game is safe.

## Several sagas at once

One browser can keep any number of sagas (different groups, different nights).
The **☰ menu** holds them, with a dot when another saga is waiting on you.
*Begin or join another* — or tapping the **ᛗ MIRKWOOD** brand — steps out to the
entry screen without leaving the saga you are in, which is how you host a second
game while a first is still running. The same list sits on the entry screen, so
you never need to remember a code.

Each card says the one thing worth knowing at a glance: whether that saga wants
a decision from you, and which one (worded by the same `awaitingText()` the bell
and the push use, so all three agree). Progress, souls and setup are all in the
same payload if a card should ever say more.

### The topbar and the menu

The topbar keeps only what changes during play: the brand (home) hard left, then
the turn banner, and — anchored right — the turn timer, stack meter, ⟲ Replay,
☰, the saga code and the connection dot. Everything else (your sagas, rules,
walkthrough, notifications, animations, leave, abandon) lives in the **☰ menu**,
and **ping is a press and hold on the board** rather than a button.

Under 900px the banner drops to its own row and `.bar-word` spans are hidden, so
the brand shows the bare ᛗ rune and the stack meter reads "80 tiles" instead of
"Hope remaining: 80 tiles" (160px → 51px; the tooltip keeps the full sense).
During the Embrace it reads "❄ Embrace". That prose was what forced the topbar
to wrap: with Replay and a turn timer showing at 375px it was three rows and
98px, and is now one button row plus the banner at 67px — plus the whole side
footer given back to the board.

Only the saga you are looking at holds a socket. That is deliberate, and it is
what makes the rest work: a saga you are *not* connected to has no live socket,
which is exactly the condition that makes its room **push** you when your turn
comes round (see the notification section above). Tapping that notification
opens straight into that saga.

Two consequences worth knowing:

- Switching is a reconnect, and it is *not* a "leave" — the room keeps your
  souls and your subscription, exactly as if you had closed the app.
- A saga that has **not started yet** frees your claimed souls when you switch
  away, because pre-start seats are released whenever a player disconnects.
  Started sagas keep your souls bound, so ongoing games are unaffected.

No server change was needed for any of this: every room's Durable Object maps
`token -> seats` on its own, so one browser's token was always a valid player in
any number of rooms.

## Playing

1. One player opens the site, enters a name, and **begins a new saga** — they
   get a 4-letter room code.
2. Friends open the same site, **join** with the code, and click a soul card to
   claim it. One player may claim several souls (so 1–4 humans can play);
   **Claim remaining souls** grabs all open seats. Each claimed soul wears one
   of eight colors and bears one of eight Norse sigils (helm, shield, axe,
   Mjölnir, longship, raven, horn, valknut) — **⚙ look** on your seat opens
   the picker; no two souls may match.
3. The host starts the game once all four souls are claimed.

## Custom art

All art is procedural SVG by default and replaceable piece-by-piece: drop
images into `public/art/` and map them in
[public/art/manifest.json](public/art/manifest.json). Any key you don't map
keeps the built-in art, so a partial reskin always looks coherent.

See **[public/art/README.md](public/art/README.md)** for the full key list,
sizes, and orientation rules (tiles are authored at rotation 0 with path
mouths centered on edges; the engine rotates the whole image). A worked
example lives at `public/art/examples/cross-sample.svg` — enable it with
`"cross": "/art/examples/cross-sample.svg"` in the manifest.

## Saga telemetry (Firebase, optional)

Every **finished** game can be mirrored as one document to a Firestore
`sagas` collection (difficulty, variants, result, loss reason, turns, stack
left, duration…) — the raw material for balance work. It is a silent no-op
until configured:

1. Create a Firebase project → Firestore database (keep the default
   locked-mode rules: no client ever reads this data, so deny-all is correct).
2. **Least privilege (recommended):** in Google Cloud console → IAM & Admin →
   Service Accounts, create a dedicated account (e.g. `mirkwood-telemetry`)
   with only the **Cloud Datastore User** role, and generate a JSON key for
   *that* account — if the key ever leaked, it could touch Firestore and
   nothing else. (The Firebase console's "Generate new private key" also
   works, but that admin account can do far more.)
3. `npx wrangler secret put FIREBASE_PROJECT_ID` → your project id.
4. `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT` → paste the entire JSON.
5. `npm run deploy`.

Both values are **Cloudflare secrets**: encrypted at rest, write-only, stored
only in your Cloudflare account — you can also manage them in the dashboard
(Workers & Pages → mirkwood → Settings → Variables & Secrets). **Nothing
Firebase-related exists in this repository**, so publishing the repo exposes
no credentials. Never commit the key JSON; `.gitignore` already excludes
`*service-account*.json` and `.dev.vars` (the file wrangler reads for local-
dev secrets, if you ever want telemetry from `npm run dev`). To rotate the
key: create a new key in IAM, re-run step 4, delete the old key.

Server-side service-account writes bypass firestore.rules — no rules changes
needed. Implementation: [worker/firestore.js](worker/firestore.js), called
from `maybeLogEnd()` in [worker/index.js](worker/index.js); the worker mints
short-lived (1 h) OAuth tokens from the key at runtime. Telemetry failures
are logged and never affect gameplay.

**Verifying**: open `https://<your-worker>/telemetry-test` in a browser. It
reports whether the secrets are configured, attempts one real test write to
the `sagas` collection, and on failure returns the exact error with hints
(missing database, Datastore-mode database, missing IAM role, malformed
secret). Games that ended *before* telemetry was configured are not
retro-logged — only sagas finishing afterward produce documents.

## Balance harness (self-play)

```
node tools/selfplay.js --games 500 --preset hard --randomRunes --seed 7
```

> Run it with **`node` directly**, not `npm run selfplay -- …`. npm 11's config
> parser eats `--flag` arguments after `--` (you'll see `Unknown cli config
> "--games"` and the run silently falls back to the defaults). `trace.js` takes
> args the same way: `node tools/trace.js <seed> --tiles '{"rune":7}'`.

[tools/selfplay.js](tools/selfplay.js) plays full games headlessly against the
real engine (~1 ms/game): win rate, loss-reason histogram, circle-economy
diagnostics, `--json` export, and `--tiles '{"rune":7}'` overrides for balance
experiments. The party's brain lives in [tools/policy.js](tools/policy.js)
(cooperative v2: shared pantheon plan, draugr-lane-aware placement, trigger
simulation so no move ever strikes a teammate, circle guarding, gateward
marching); [tools/trace.js](tools/trace.js) replays one seed with an annotated
log for debugging.

**State of play (v3, ~10k games):** the party completes real games —
**0.1% wins on Normal (1/1000), 0.2% on Hard, 5% on the no-draugr control**.
~24% of Normal games gather all four matching marks; remaining deaths are
Niflheim stalemates (network fragmentation — fractured bridges crumble behind
the first crosser) and late falls. The v3 breakthroughs, each found by tracing
real lost games with `tools/trace.js`: target the gate's **doorway cell**, not
the gate (souls literally camped against its back wall); treat **Void Rifts as
teleports** (jump, land in the rift's row/column near the doorway — the only
way home for a severed soul); anchor late-game movement to the **gate-connected
component** (pairs otherwise strand 2+2); never jump without a ~7-tile stack
margin (landing happens a full round later); and a gate-stander never leaves
(their light holds the doorway tile alive).

Calibration: experienced humans win TNC ~2%, so the greedy bot at 0.1% is
plausibly ~20× weaker than practiced play — **still no license to retune tile
counts**. Next levers: planned crossing order for fractured bridges, smarter
convergence timing, or 2-ply lookahead in `tools/policy.js`.

## Room quality-of-life

- **Invite links**: click the room code (lobby or top bar) to copy
  `https://…/?room=CODE`; opening it joins directly (first-time visitors get
  the code pre-filled so they can pick a name).
- **Connection dot** (top bar): green connected / amber reconnecting.
- **Release, kick & adopt**: any player can release their own souls (✕ on the
  player card, e.g. to hand a seat to a latecomer), and the host can release
  anyone's; anyone can **adopt** an unclaimed soul mid-game — the rescue for a
  player who vanished. An adopted soul keeps its look but takes its new
  keeper's name (the handoff is told in the saga log).
- **Watchers**: joining a full saga makes you a spectator — you see the whole
  game live, you're listed ("watching from the mist", with an arrival toast),
  and you can adopt any soul the moment it's released.
- **Live placement preview**: out-of-turn players and watchers see the active
  player's tile as it's being placed — ghosted on the board where they're
  hovering it, at their current rotation, outlined in their colour with a name
  chip (plus a read-only "◈ Name is placing" panel). Purely visual: the active
  player's client relays its pending cell+rotation via an ephemeral `preview`
  message the Worker fans out (never touches game state or storage); it clears
  when the move is finalized.
- **Ping**: any player or watcher can point the group at a spot without voice
  chat — hit **⚑ Ping** in the top bar, then tap a board cell to drop a
  transient sonar marker (in your soul's colour, tagged with your name) that
  everyone sees. Same ephemeral relay pattern as the live preview (no game
  state, no storage); armed pings win over the cell's normal move/place.
- **Walkthrough**: an optional 8-page illustrated primer (goal, hope, moving &
  kindling, Resolve, draugar, rifts, runes & gates, the Embrace) drawn with
  the game's own tile art — from the lobby or the in-game rules screen.
- **Turn timer** (host option): a soft countdown per decision (60s–3min) in
  the top bar — a nudge, not an enforcer.
- **Idle auto-rest**: a player who has already moved but forgets **End turn**
  won't stall the party. Two paths, because one alone has a hole:
  - *Foreground and idle*: after 30s with no mouse/key/touch input the page
    ends the turn itself (any activity resets the clock; a countdown shows on
    the button for the final 10s).
  - *Backgrounded*: that 30s timer runs on a `setInterval`, which a frozen
    (backgrounded) page suspends — so on a phone it never fired, and a pocketed
    player stranded everyone. Now the server ends the post-move turn the moment
    the `away` message arrives (the same signal the notification tier uses). It
    is post-move only: prompts where a real decision is still owed are pushed,
    never auto-acted.
- **No chat, by design**: there is no in-app messaging and no user-to-user
  message content is relayed or stored anywhere; coordination happens by
  **pressing and holding a spot on the board** to ping it for everyone
  (ephemeral, never persisted). The hold is watched so a ping never also
  places a tile.
- **State versioning**: rooms persisted by an older engine version are
  gracefully reset to the lobby after a deploy instead of crashing
  (`STATE_VERSION` in the engine — bump it on breaking state changes).

## Architecture

| Piece | Role |
|---|---|
| `public/shared/engine.js` | Pure rules engine (no I/O). A queue-driven state machine: every player decision is an `awaiting` prompt; `applyAction` validates and advances. Bundled into the Worker *and* served to the browser for constants/tile geometry — one source of truth. |
| `worker/index.js` | Worker entry (routes `/ws?room=CODE` upgrades to the room's Durable Object) + `MirkwoodRoom` DO: hibernating WebSockets, seats/members, engine state persisted to DO storage on every action. Broadcasts `publicState` (path stack redacted to a count). |
| `public/` | No-build browser client: procedural Norse-forest SVG tile art (replaceable via the art manifest), placement previews with rotation (press **R**), modals for rune attunement / bracing / endgame, saga log, in-app rules reference, and a per-soul status card (Soul tab / click any player card). The engine emits semantic events per action (`state.events`) and the client choreographs them into a sequence — token slides, fracture collapse, draugr shriek + corridor strike wave, hit shakes, hope dimming, mist fades, rune bursts — with an "Animations" on/off toggle (persisted per browser). |
| `test/engine.test.js` | 150 assertions across every mechanic plus a 200-game random self-play soak. |

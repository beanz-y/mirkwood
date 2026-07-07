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

Notes:
- The `migrations` block in [wrangler.jsonc](wrangler.jsonc) declares the
  `MirkwoodRoom` Durable Object as SQLite-backed — required for the free plan.
- Rooms self-purge 24 hours after the last activity (DO alarm).
- Reconnects: the browser keeps a token in localStorage and rejoins its seats
  automatically — refresh mid-game is safe.

## Playing

1. One player opens the site, enters a name, and **begins a new saga** — they
   get a 4-letter room code.
2. Friends open the same site, **join** with the code, and click a soul card to
   claim it. One player may claim several souls (so 1–4 humans can play);
   **Claim remaining souls** grabs all open seats.
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
npm run selfplay -- --games 500 --preset hard --randomRunes --seed 7
```

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
- **Kick & adopt**: the host can release another player's soul (✕ on seat or
  player card, lobby or mid-game); anyone can **adopt** an unclaimed soul
  mid-game — the rescue for a player who vanished.
- **Turn timer** (host option): a soft countdown per decision (60s–3min) in
  the top bar — a nudge, not an enforcer.
- **State versioning**: rooms persisted by an older engine version are
  gracefully reset to the lobby after a deploy instead of crashing
  (`STATE_VERSION` in the engine — bump it on breaking state changes).

## Architecture

| Piece | Role |
|---|---|
| `public/shared/engine.js` | Pure rules engine (no I/O). A queue-driven state machine: every player decision is an `awaiting` prompt; `applyAction` validates and advances. Bundled into the Worker *and* served to the browser for constants/tile geometry — one source of truth. |
| `worker/index.js` | Worker entry (routes `/ws?room=CODE` upgrades to the room's Durable Object) + `MirkwoodRoom` DO: hibernating WebSockets, seats/members, engine state persisted to DO storage on every action. Broadcasts `publicState` (path stack redacted to a count). |
| `public/` | No-build browser client: procedural Norse-forest SVG tile art (replaceable via the art manifest), placement previews with rotation (press **R**), modals for rune attunement / bracing / endgame, saga log + chat, in-app rules reference, and a per-soul status card (Soul tab / click any player card). The engine emits semantic events per action (`state.events`) and the client choreographs them into a sequence — token slides, fracture collapse, draugr shriek + corridor strike wave, hit shakes, hope dimming, mist fades, rune bursts — with an "Animations" on/off toggle (persisted per browser). |
| `test/engine.test.js` | 104 assertions across every mechanic plus a 200-game random self-play soak. |

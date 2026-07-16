# MIRKWOOD — Project Handoff

*Written 2026-07-07 by the previous Claude instance at the end of the initial build
sessions. Read this first; then RULES.md for the game rules and README.md for
run/deploy. Everything below has been built, tested, and browser-verified.*

> **Addendum (2026-07-07, separation & mythos pass):** terminology below is
> partially stale. Player-facing names are now **Berserk / Ward / Press On**
> (formerly Charge / Sustain / Move Again — internal payload kinds `charge`,
> `sustain`, `canMoveAgain` are unchanged); rune sets realigned (Ansuz →
> Valhalla, Fehu in, Isa out) with **STATE_VERSION = 2**; *draugar* plural,
> *kindle*, *Ember of Hope*, Sigrun replaced Eira. All near-verbatim TNC
> rulebook phrasing was rewritten. RULES.md departures #14–15 document it.
> The repo is on GitHub now; push to main deploys via Workers Builds.

> **Addendum (2026-07-10, PWA + notifications):** Mirkwood is now an
> installable web app (public/manifest.webmanifest + cache-free public/sw.js +
> icons, gold ᛗ Mannaz). Opt-in TURN NOTIFICATIONS shipped as **local
> notifications only** (topbar bell, never auto-prompts): they fire when the
> tab/app is BACKGROUNDED and a decision is on a soul this browser controls.
>
> **Addendum (2026-07-16, closed-app notifications via Web Push): DONE.**
> The second tier is built, so a CLOSED installed app now rings too. Shape:
> - `worker/push.js` — RFC 8291 payload encryption (ECDH → HKDF → aes128gcm)
>   and RFC 8292 VAPID (ES256 JWT). Written against WebCrypto, no dependency.
>   Inert unless the secret is set, exactly like `worker/firestore.js`, so the
>   repo still carries zero key material and is safe to publish.
> - **ONE secret: `VAPID_JWK`** (dashboard → Settings → Variables and Secrets,
>   type Secret; Dan is dashboard-only). `node tools/vapid-keys.mjs` prints it.
>   The PUBLIC key is *derived* from it and served from `/push-key`, so the two
>   can never drift — this is why it is one secret and not two.
> - `/push-test` is the runtime-visibility diagnostic, sibling of
>   `/telemetry-test` (same dashboard-vars trap: Build variables never reach
>   the running Worker).
> - **The tiers divide on one question**: is the awaiting seat's token still
>   holding a live WebSocket? Yes → their own browser rings it, Worker stays
>   quiet. No → `maybePush()` pushes. Both hinge on the page being alive, so
>   exactly one can fire. Trigger points: after `act` and after `start`.
> - Subs live in `room.subs` (token → up to 3 devices), purged with the room,
>   on `leave`, on bell-off (`push-unsub`), and when a push service reports
>   404/410. Sends go through `ctx.waitUntil` and never block a saga.
> - `awaitingText()` moved INTO `public/shared/engine.js` so the bell and the
>   push read one table (`test/push.test.js` scans the engine for prompt types
>   and fails if any lacks text — it also caught `stocked-hearth`, which the
>   old client-side map was missing).
>
> **How it was verified** (the pane cannot grant push permission):
> 1. Crypto: `test/push.test.js` reproduces **RFC 8291 §5's published message
>    body byte for byte** from the RFC's fixed keys/salt. This matters because
>    a browser silently DROPS a payload it cannot decrypt — the failure would
>    be invisible until a real device showed nothing.
> 2. That test runs under Node, not workerd, so it does not prove the Workers
>    runtime has the primitives. Pointed a test subscription at a reachable
>    host and got **HTTP 405 back** — i.e. encryption + VAPID signing + the
>    POST all really executed inside workerd. (An unreachable endpoint returns
>    an opaque "internal error" that is indistinguishable from a crypto
>    exception — don't trust that alone.)
> 3. Decision logic: two sagas via raw WS (A holds souls 0/2/3, B holds soul
>    1), identical up to the moment the saga turns to B — B connected = no
>    push, B's socket closed = exactly one push for seat 1. Harness in the
>    session scratchpad (`push_trigger_test.mjs`), not committed: it needs a
>    running dev server.
>
> **STILL OPEN:**
> - **Real-device test is Dan's** (iOS: install to Home Screen first, 16.4+).
>   Nothing rings until `VAPID_JWK` is set in the dashboard.
> - **Privacy notice not yet updated** — wording is Dan-approved text, and push
>   adds a real new flow (a subscription address, plus the player's device
>   talking to Google/Apple/Mozilla's push service, which the notice currently
>   doesn't mention since Cloudflare was the only third party). A draft is in
>   the session summary. **Update the notice BEFORE setting the secret**; the
>   feature is dark until then, so the ordering is free.
> - Known gap: if a mobile OS freezes the page but holds the socket open, the
>   Worker still sees it as live and stays quiet while the frozen page can't
>   ring. The page catches up on wake. Not worth a heartbeat unless it bites.
> - `.dev.vars` (gitignored) holds a throwaway VAPID key for local testing, so
>   `npm run dev` reports push as configured. It is not the production key.

---

## What this is

**Mirkwood (Myrkviðr)** is Dan's Norse-mythology adaptation of the board game
*The Night Cage* (TNC — rulebook PDF was in his Downloads): a cooperative
tile-placement game where 4 Viking souls explore a mist-shrouded 6×6 forest
(edges wrap) seeking the gates of Valhalla and Fólkvangr. It's a web app for
online play at **`E:\Claude\mirkwood`** — not a git repo yet.

- **Run locally:** `npm run dev` (wrangler dev, port 8930). **Test:** `npm test`
  (104 assertions + 200-game random self-play soak — keep it green).
  **Deploy:** Dan is dashboard-only, NO CLI — the repo connects to a Worker
  via the dashboard's Git integration (Workers Builds), so `git push` to main
  deploys. Never tell him to run wrangler commands; dashboard paths only
  (secrets: Settings → Variables and Secrets). See README "Deploying".
- 1–4 humans control the 4 souls; rooms are 4-letter codes; one player may
  claim several seats. Reconnect is automatic (localStorage token).

## Game rules in one paragraph (full detail: RULES.md)

Souls are Hopeful (see/illuminate 1 tile around them) or Hopeless (see only
their tile, must move, move blind). Each turn: Move (reveal tiles at your open
passages, unlit tiles are lost forever) or Stay (+1 Resolve max 2, burn a stack
tile). Fractured tiles crumble to Void Rifts behind you; falling drops you out
and you land hopeless in the rift's row/column next turn. Draugr strike
everyone in straight-line sight when anyone moves (3 tiles burned + hopeless
each; move out of the line and it misses you, +1 Resolve). Resolve spends:
Move again / Rekindle / Endure / Brace (3→2) / Charge / Sustain. Each soul
bears one rune mark from Rune Circles; win = all 4 souls on the same Gate with
4 *distinct* runes of that gate's set. Stack empty = Niflheim's Embrace (a
board tile is removed after every turn). Lose: both gates lost, rune circles
can't complete the set (auto-checked), a faller with no tile to land on, or
concession.

## Key design decisions & departures from TNC (rationale in RULES.md §Design decisions)

1. Rune glyphs corrected to real Elder Futhark (Dan's draft had mismatches).
2. Resolve is earned by *evading* a triggered Draugr, never by being hit
   (else Brace would be free).
3. **Rekindle** (new spend): hopeless soul spends 1◆ at turn start to relight —
   required because falls land you hopeless (Dan's rule) and a lone faller
   would otherwise be unrecoverable.
4. Two single-doorway Gates, permanent once placed, exempt from Niflheim
   removal; still losable from the stack (watch the discard tracker).
5. No rune passing (TNC passes keys); re-attunement is the safety valve.
6. **Charge** (Dan's playtest rule): strike always lands on the charger, and
   after the attack resolves *and the charger scrambles off*, the Draugr is
   **banished** — bare ground, tile discarded. Only deliberate charges banish;
   fall-onto → rift; blind stumble → remains.
7. **Sweep before rekindle** (Dan's playtest rule): after every arrival, unlit
   tiles are removed *before* the relight check, so a monster abandoned in
   hopelessness can't be preserved by a rekindle a moment later.
8. **Rekindled souls place their own tiles** (Dan: "a player never places
   tiles for another player") — departs from TNC where the current player draws.
9. **Random Runes** (host variant): the stones assign a random rune not borne
   by any soul (decline allowed). With it, **lingering**: Staying on a Rune
   Circle doesn't crumble it — tile burns, turn passes, fresh draw each turn;
   crumbles on leave.
10. Stay ends the turn (no stay-then-move-again); scrambling never re-triggers
    the attack; landing choice is row∪column at landing time.

## Architecture

| Piece | What to know |
|---|---|
| `public/shared/engine.js` | **Single source of truth.** Pure rules engine, no I/O. Queue-driven state machine: `s.queue` of steps, `s.awaiting` = the one pending player decision (`type` + `seat` + options); `applyAction(state, seat, payload)` validates and runs until the next decision. Emits semantic **events** (`move/fall/land/fracture/reveal/attack(+rays)/hit/sweep/banish/rune/rekindle/stay/burn`) per action into `s.events` (cleared each action) and `s.turnEvents` → snapshotted to `s.lastTurn` at each begin-turn (drives Replay). `publicState()` redacts the stack to a count. Difficulty: `TILE_PRESETS` (normal/hard) + `normTiles()` clamps. Bundled into the Worker AND served to the browser. |
| `worker/index.js` | Cloudflare Worker entry + `MirkwoodRoom` Durable Object (SQLite-backed = free plan; declared in wrangler.jsonc migrations). One DO per room, addressed by code; hibernating WebSockets (`serializeAttachment` holds the token); room + engine state persisted to DO storage on every action (survives disconnects/restarts); 24h idle purge alarm. Handles: create/join/claim/claimAll/config/start/act/concede/restart/chat/leave. Seat ownership validated per action. Host handoff on leave; pre-game seats freed on disconnect; restart prunes absent players' seats. |
| `public/client.js` | No-build browser client. Renders whole board SVG per state. **Animation choreography:** `buildTimeline(events, cap)` assigns sequential start times; CSS overlays use `animation-delay` + `fill-mode: both`; delayed SMIL uses `begin="indefinite"` + `beginElementAt` (`data-mk-delay` attr) because SMIL begin offsets are document-relative. Token movement = chained translate segments (multi-move turns replay smoothly). Procedural Norse tile art (shared `#mk-*` gradient defs injected at startup) with **art-manifest overrides**. Animations toggle (`mk-anims` localStorage) strips ALL motion. |
| `public/art/` | Custom art system: `manifest.json` maps keys → images (per-tile replacement, procedural fallback). Full artist spec in `art/README.md` (rot-0 orientation, ~29% path mouths, `-fractured` variants, `token-0..3`, `rift/mist/board-bg`). Example: `examples/cross-sample.svg`. |
| `test/engine.test.js` | 104 assertions covering every mechanic + playtest rules + difficulty + replay + random runes, plus the 200-game soak. Test decks: `deck(n)` = 2 gates + 4 rune circles + n crosses (4 circles needed or the rune-scarcity auto-loss fires instantly). |

Client↔server protocol: JSON over WS at `/ws?new=1` or `/ws?room=CODE` (URL
routes to the DO). Messages: `create/join/claim/claimAll/config/start/act
{payload}/concede/restart/chat/leave`; server sends `joined/room/state/chat/
error{fatal?}`.

## UI features

Lobby (name → create/join → seat claiming → host difficulty panel with
Normal/Hard presets + full tile-count customization + Random Runes toggle,
summary synced to all). In-game: turn indicators (TURN chip, rotating token
ring, ◈ banner, board glow on your decision), tile preview with rotation (R
key), modals (attune / rune-draw / brace / confirm / endgame), Soul status card
tab (per-soul do's/don'ts + resolve spends, click any player card), in-app
rules modal, saga log + chat tabs, discard tracker, ⟲ Replay (previous
player's whole turn, available to everyone incl. late joiners), Animations
toggle, Leave buttons everywhere (lobby/in-game/endgame), mobile layout
(tab panes have fixed heights — they collapse to 0 otherwise).

## Working conventions (Dan)

- Dan commits to main himself and runs deploys — build and verify, don't nag
  about git (no repo here yet anyway).
- Playtest-feedback driven: he brings specific rule changes; implement
  faithfully, flag balance implications, document departures in RULES.md's
  numbered list.
- Firebase deliberately NOT integrated: DO storage covers live play. The seam
  for later (stats/accounts/invite gate like his other apps) is `save()` in
  worker/index.js.
- Preview-tab gotcha: Chrome throttles timers/rAF in the hidden preview tab
  after ~5 min — reload the page or restart the preview before long eval loops
  or screenshots.

## Watchlist / open balance questions

- **No evidence the game is winnable by good play** (random play: 0/200).
  Priority: telemetry or a heuristic bot. Knobs: rune circle count (6),
  landing-hopeless, 3-tile hit penalty.
- Evade-Resolve farming (dance in/out of draugr sight); tile costs probably
  self-police — watch.
- Linger + Stay is slightly self-funding (+1◆ per re-roll turn, cap 2); lever:
  skip resolve gain on linger turns (one line in `doStay`).
- Hard (5 circles) + rune-scarcity auto-loss is knife-edged; Random Runes'
  linger rule was added partly to defuse Random+Hard.
- Gate assembly funnel: single doorway + single-occupancy approach tile means
  the last souls queue up; seems thematic, confirm it isn't miserable.

## Built in the final session (all verified)

- **Firestore telemetry**: one doc per finished saga → `sagas` collection.
  `worker/firestore.js` (service-account JWT → REST API; bypasses rules);
  called from `maybeLogEnd()` in the DO. **Inert until Dan configures BOTH
  as Cloudflare secrets**: `FIREBASE_PROJECT_ID` + `FIREBASE_SERVICE_ACCOUNT`
  (`wrangler secret put …`). Nothing Firebase-related lives in the repo —
  safe to publish. README documents least-privilege setup (dedicated SA with
  only Cloud Datastore User role) and key rotation. Never blocks gameplay.
- **Invite links**: `/?room=CODE` auto-joins (first-timers get code pre-filled
  to pick a name); clicking the room code (lobby or topbar) copies the link.
- **STATE_VERSION** (engine export, currently 1): DO `load()` resets
  mismatched persisted sagas to the lobby with a friendly notice. **Bump it on
  any breaking state-shape change.**
- **Admin QOL**: connection dot (topbar); host kick (✕ on seats/player cards,
  lobby AND mid-game); anyone may **adopt** an unclaimed soul mid-game (worker
  'kick' msg + mid-game 'claim' of vacant seats) — the vanished-player rescue.
  Orphaned lobby hosts (lost token) hand off to the next joiner.
- **Soft turn timer** (host option, 60s–3min, in room.config): per-decision
  countdown in the topbar; social pressure only, no auto-action.
- **Self-play harness**: `npm run selfplay -- --games 500 --preset hard
  --randomRunes --tiles '{"rune":7}' --json out.json`. Runner in
  `tools/selfplay.js`; the party's brain in **`tools/policy.js`** (v2
  cooperative: shared pantheon plan with on-board-gate pivoting, draugr-lane
  placement risk weighted by live draw probability, trigger simulation so no
  move strikes a teammate, damage-minimizing forced-draugr placement, circle
  guarding + guarded-circle treks, locality-aware movement — paths evaporate,
  distant goals are illusions — gateward marching with sideways-draw
  suppression, no-suicide cornered-stay rule); `tools/trace.js SEED` replays
  one game with an annotated log.

  **Findings after ~10k games (v3): THE BOT WINS REAL GAMES** — Normal 0.1%
  (1/1000), Hard 0.2%, no-draugr control 5%. ~24% of Normal games gather all
  4 marks; the rest of the losses are Niflheim stalemates (network
  fragmentation) and late falls. Every breakthrough came from TRACING a lost
  seed (`node tools/trace.js SEED --tiles '{...}'` prints the board when the
  stack died + at the end), never from weight-tweaking blind. v3 principles
  now encoded in policy.js, in discovery order:
  - locality: paths evaporate; only chase goals with a lit road (≤2) or a
    teammate-guarded circle (≤5); otherwise fish fresh mist near yourself
  - plan pivots decisively to an ON-BOARD gate (permanent = safe to swear to)
  - the cornered-stay rule: never leap into a rift merely because it is the
    only move (this suicided fully-marked parties one tile from home)
  - **target the gate's DOORWAY cell, not the gate** (souls literally lined
    up against its back wall and sustained forever)
  - **Void Rifts are teleports**: jump and land in the rift's row/column near
    the doorway — the only rescue for a soul severed from the gate network —
    but never without ~7 tiles of stack margin (landing is a round away)
  - late-game anchor = the GATE-CONNECTED component, not "near a teammate"
    (pairs strand 2+2 otherwise); gate-standers never leave (beachhead light
    holds the doorway tile alive); Niflheim removals spare shortest-road cells
  Human benchmark: Dan+wife ~2% at TNC → greedy bot at 0.1% ≈ 20× weaker than
  practiced humans, plausible. **Still no license to retune tile counts.**

## Recommended next steps (not started)

1. **Push the bot toward ~1-3%** (the human-calibrated band) before judging
   balance: remaining known weaknesses are fractured-bridge crossing order
   (bridges crumble behind the first crosser → plan single-file order or
   route redundancy), convergence timing (finish marks with stack ≥ 20), and
   possibly 2-ply lookahead. Trace stalemate seeds first; the boards tell you
   the story. Script work — never have Claude play games manually.
2. Sound manifest mirroring the art manifest, hooked into the event timeline
   (shriek/fracture/rune/banish), with a mute toggle.
3. End-of-game "Saga Chronicle" shareable summary screen.
4. Later, after balance: Advanced-game monsters gated by the difficulty panel —
   Garm (Keeper), Níðhöggr (Pit Fiend/diagonal rifts), Hel's Herald (Dirge/omens).
5. git init + GitHub + CI running npm test.

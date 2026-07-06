# Mirkwood (Myrkviðr)

A cooperative, online, 4-player tile-placement game of Viking souls lost in the
mist-forest Myrkviðr, seeking the gates of Valhalla and Fólkvangr. Adapted from
*The Night Cage* — full rules and design notes in [RULES.md](RULES.md).

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

One-time setup:

```
npx wrangler login          # opens browser, authorize your CF account
npm run deploy
```

That's it — the deploy prints your URL (`https://mirkwood.<your-subdomain>.workers.dev`).
Send that link and a room code to the playtest group. Subsequent deploys are
just `npm run deploy`.

Optional, in the Cloudflare dashboard: attach a custom domain to the Worker
(Workers & Pages → mirkwood → Settings → Domains & Routes).

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

## Firebase — when (and whether) you need it

Live play needs **no external database**: room + game state live in each
room's Durable Object storage, which is simpler, faster, and credential-free.

Firestore becomes worth adding when you want data that outlives a room:
saga history / win-loss stats, player accounts, or an invite-code gate like
your other projects. The integration seam is `save()` in
[worker/index.js](worker/index.js) — every completed game passes through it,
so mirroring a finished saga's summary to Firestore (via the Firestore REST
API with a service-account token in a Worker secret) is a ~30-line addition
that doesn't touch the engine.

## Architecture

| Piece | Role |
|---|---|
| `public/shared/engine.js` | Pure rules engine (no I/O). A queue-driven state machine: every player decision is an `awaiting` prompt; `applyAction` validates and advances. Bundled into the Worker *and* served to the browser for constants/tile geometry — one source of truth. |
| `worker/index.js` | Worker entry (routes `/ws?room=CODE` upgrades to the room's Durable Object) + `MirkwoodRoom` DO: hibernating WebSockets, seats/members, engine state persisted to DO storage on every action. Broadcasts `publicState` (path stack redacted to a count). |
| `public/` | No-build browser client: SVG board, art-manifest skinning, placement previews with rotation (press **R**), modals for rune attunement / bracing / endgame, saga log + chat. |
| `test/engine.test.js` | 64 assertions across every mechanic plus a 200-game random self-play soak. |

# Self-play tool — working notes / handoff

*Written 2026-07-09 at the end of a "make the bot more human-like" session.
Read this before touching `tools/`. High-level context is also in the project
memory; this file is the technical detail a coding session needs.*

---

## VERDICT (2026-07-09 session 2 — parameterization + automated tuning)

**The greedy heuristic is at its representational ceiling. Do not spend more
time tuning the bot for Normal — the win-rate lever is game balance.** Proven
this session, three ways:

1. **Balance sweep** (why the bot can't win Normal). Win rate barely responds to
   rune count but explodes with the *tile budget* — the game is a race against
   the stack emptying (Niflheim then shrinks the board and severs the party):

   | Config (40k/6k games) | win% |
   |---|---|
   | Normal (baseline) | ~0.10% |
   | rune 6→8→10→12 | 0.17 → 0.23 → 0.77 → 0.87% |
   | no draugr | 0.8% |
   | no draugr + rune 10 | 3% |
   | no draugr + rune 10 + **+28 tiles** | **~20%** |

   The dominant loss, once scarcity is relieved, is **"the cold has severed
   every road"** — fragmentation under Niflheim. It is *structural* (paths
   crumble behind souls; the board only shrinks), not a weighting problem.

2. **CEM weight tuner** (`tools/tune.js`, built this session). A cross-entropy
   search over all ~14 movement weights, ~500k games, found **no vector that
   beats the hand-tuned defaults on win rate.** It improves a shaped proxy
   (souls-home + marks) by ~5% but that does **not** convert to wins (held-out
   40k: default 39 wins vs tuned 43 — noise). Confirms the ceiling by search,
   not by hand.

3. **"Converge harder" is counterproductive.** A convergence model (universal
   doorway-pull on a Niflheim clock + a rune-role coordinator) was built and
   **REVERTED**: at hand-set weights it *lost* on the winnable control (17% vs
   the original 20%); every "cohere/converge harder" hand-probe scored 15.5–17%
   vs 20%. The original balance already beats them. The only thing tuning found
   was how to neutralise the new terms back to par.

**What was kept** (behaviour-neutral infrastructure — `policy(s,rnd,{})` is
byte-for-byte the old greedy party, verified by reproducing the exact loss
histogram): the movement weights are now lifted into `DEFAULT_PARAMS`
(overridable via `ctx.params`), and `selfplay.js`/`tune.js` gained `--params`.
This is the apparatus for the *next* balance/ruleset change, where the right
weights will differ — not a bot improvement in itself.

**Recommendation to Dan (unchanged, now evidence-backed):** get real
skilled-human Mirkwood games to set the true target, then treat **rune-circle
count and the Niflheim tile budget** as the difficulty dials (the sweep above
quantifies both). The one *structural* bot idea that might raise the ceiling —
not chased here — is smart **Berserk/charge draugr-banishing**: the no-draugr
control wins ~5–8× more, so monsters (via forced falls) are what scatter the
party into the fatal fragmentation.

---

## TL;DR (original — 2026-07-09 session 1)

- The bot (`tools/policy.js`) wins **~0.1% on Normal** and is stuck there.
- It loses to two modes that **trade off** against each other, so tactical
  tweaks redistribute losses without lowering the total:
  - **~57–74% "Too many Rune Circles are lost to the mist"** (rune scarcity —
    6 circles for 4 required marks is tight).
  - **~14–30% "The cold has severed every road"** (fragmentation — the party
    can't all reach a winnable gate before Niflheim shrinks the board).
- Two things were built this session (both committed, engine tests 125 green):
  1. **Targeted heuristic fixes** — default-on, still ~1ms/game.
  2. **Rollout lookahead** — opt-in via `--rollouts M`, off by default.
- **Open question that matters more than the bot:** the ~2% target is a *The
  Night Cage* number and was **never measured for Mirkwood**, which is likely
  harder (rune circles + the severed-road auto-loss). Get real skilled-human
  Mirkwood games before over-investing in bot tuning.

## How to run (IMPORTANT)

Run with **`node` directly** — NOT `npm run selfplay -- …`. npm 11 eats
`--flag` args after `--` ("Unknown cli config") and silently runs the defaults.

```
node tools/selfplay.js --games 1000                       # greedy, ~1ms/game
node tools/selfplay.js --games 500 --rollouts 5           # lookahead, ~280ms/game
node tools/selfplay.js --games 1000 --preset hard --randomRunes
node tools/selfplay.js --games 2000 --tiles '{"rune":7}'  # balance experiment
node tools/selfplay.js --games 1000 --json out.json
node tools/selfplay.js --games 5000 --params my.json      # play with tuned weights
node tools/trace.js 1002                                   # replay one seed, annotated
node tools/tune.js --iters 12 --pop 24 --games 1500 --out best.json   # CEM tuner
```

Flags (`tools/selfplay.js`): `--games`, `--seed` (default 1000), `--preset`
(normal|hard), `--randomRunes`, `--verbose`, `--json <file>`, `--tiles '{…}'`
(override any tile count), `--rollouts N` (0 = greedy), `--params <file|json>`
(override `DEFAULT_PARAMS` weights — inline `'{"march":4}'` or a JSON file).

`tune.js` flags: `--iters`, `--pop`, `--elite`, `--games` (per eval), `--seed`,
`--preset`, `--randomRunes`, `--tiles`, `--sigma` (init std as a fraction of each
weight), `--out`. **Perf gotcha:** a single-process background run must write its
own log (`> tools/x.log 2>&1`) — the harness capture file stays empty — and
never launch two tuners into the same `--out`/log (they interleave and corrupt
it). One run is ~14 CPU-min at pop 30 × 2000 games × 14 iters.

Seeds: game `g` uses seed `BASE_SEED + g` (default 1000+g). `trace.js <seed>`
replays exactly one game and prints the board when the stack dies + at the end.

## File / function map

- **`tools/selfplay.js`** — runner. `playGame(seed)` is the loop:
  `while not ended: applyAction(s, s.awaiting.seat, policy(s, rnd, ctx))`.
  `ctx = { rollouts: ROLLOUTS }` (+ `ctx.params` if `--params`). Aggregates win
  rate, loss-reason histogram, circle-economy diagnostics.
- **`tools/policy.js`** — the brain. Key pieces:
  - `DEFAULT_PARAMS` — the ~14 tunable movement weights (victim, runeReach,
    gateFishBase/Late, march/marchAll, assembly, nearGate, caravan, straggler,
    rescueLate, fractureLate, …). Defaults ARE the original literals, so
    `policy(s,rnd,{})` is the unchanged hand-tuned party; `ctx.params` overrides.
  - `policy(s, rnd, ctx)` — dispatch on `s.awaiting.type`. The `'action'` case
    (move/stay) is where lookahead lives. Reads weights via `scoreMove`'s
    `const P = ctx.params || DEFAULT_PARAMS`.
  - `scoreMove(...)` — the greedy heuristic (big; encodes locality, gate-
    connectedness, caravan, guard-duty, straggler rule, cohesion, urgency…).
    This is the hard-won wisdom; the rollout ADJUSTS it, never replaces it.
  - `scorePlacement(...)` — greedy tile placement (draugr-lane-aware).
  - `runeEconomy(s, plan)` → `{ marksNeeded, circlesLeft, slack }`. `slack` is
    the margin before the rune-scarcity auto-loss. Stashed on `ctx.econ`.
  - Rollout block: `cloneState`, `resampleStack`, `rolloutReward`,
    `rolloutToEnd`, `rolloutValue`. See below.
- **`tools/tune.js`** — CEM weight optimiser over `DEFAULT_PARAMS`. Samples a
  Gaussian population of weight vectors, scores each on a fixed seed block
  (common random numbers) by a **dense shaped reward** (`terminalReward`:
  souls-home + marks + near-win bump; a real win = 1.0), keeps the elite, refits
  the Gaussian, repeats; validates the winner on a held-out block. Shaped reward
  is used because wins (~0.1% on Normal) are far too rare to rank candidates by.
  `KEYS`/`BOUNDS` auto-adapt to whatever `DEFAULT_PARAMS` exposes. Verdict above:
  it found nothing that beats the defaults on Normal — keep it for future
  balance/ruleset work, where the optimum will move.
- **`tools/trace.js`** — single-seed replayer (annotated log + board dumps).

## Rollout lookahead — design & knobs

Only the `'action'` (move/stay) decision uses rollout, and only the **top-4
greedy candidates** are rolled out (greedy already ranks them). For each:

```
value = greedyScore  +  0.06 * rolloutValue(action)  +  small noise
```

`rolloutValue` = average over `M` (= `ctx.rollouts`) rollouts. Each rollout:
`cloneState` → `resampleStack` (Fisher-Yates a copy of the remaining stack —
the human-like bit: the bot knows tile COUNTS, not order) → apply the candidate
→ `rolloutToEnd` (finish greedily, `ctx.rollouts:0` so no nesting) →
`rolloutReward`.

`rolloutReward(s)` (measured on the BEST gate, so a rollout that pivots
pantheon still scores its work):
```
win → 1000
else → marks·40 + soulsOnGate·22 + soulsConnectedToGate·8 + gateOnBoard·12
```

**Tunable knobs** (all in `policy.js`):
- `0.06` — rollout weight vs greedy. Higher = rollout dominates (risks noise);
  lower = barely moves off greedy.
- reward weights `40 / 22 / 8 / 12` — the `connected·8` term is what cut
  fragmentation 30%→14%, but over-weighting it starved mark-gathering (scarcity
  57%→74%, marks 2.7→2.4). This is the trade-off dial.
- `K = 4` (candidates rolled out), `M` (rollouts per candidate, via `--rollouts`).
- `cloneState` uses `structuredClone` — **the perf bottleneck**. A lean manual
  clone (copy only engine-read fields; the engine writes but never branches on
  `log/events/turnEvents/lastTurn`) would speed rollouts up a lot and enable
  larger M.

## Baselines (Normal, 1000 games unless noted)

| Config | win% | scarcity | fragmentation | avg marks | ms/game |
|---|---|---|---|---|---|
| greedy (pre-session) | 0.1 | 590 | 297 | 2.6 | 1 |
| greedy + targeted fixes (current default) | 0.1 | 569 | 319 | 2.7 | 1 |
| rollout M=5 (500 games) | 0.4* | 369 (74%) | 69 (14%) | 2.4 | 280 |

\* wins are too rare (~0.1–0.5%) to measure reliably at feasible sample sizes.
**Measure with the intermediate signals instead** — `avg matching marks` and
the scarcity-vs-fragmentation split move meaningfully and aren't noise.

## Untried ideas / next steps (roughly in value order)

1. **Balance the rune-circle count** — the data's loudest signal. Even a
   connected lookahead party loses ~74% to scarcity. Run `--tiles '{"rune":7}'`
   and `'{"rune":8}'` (Normal is 6) to quantify how much the circle budget
   drives the win rate. (Handoff withheld "license to retune until the bot hits
   the human band" — but the bot now suggests the budget is *why* it can't.)
2. **Global rune-assignment plan** — the bot assigns runes greedily ("first
   free rune when you land on a circle"). A human assigns "you take Thurisaz,
   you take Eihwaz…" up front and routes each soul to gather its mark near the
   gate. This directly attacks the scarcity/fragmentation coupling (gather the
   RIGHT marks in the RIGHT places). Probably the highest-leverage smart-play
   change.
3. **Faster clone** → larger M → less-noisy rollout values → can raise the
   rollout weight without picking noise.
4. **Tune the reward trade-off** (`connected·8` vs marks·40) toward a balance
   that lowers BOTH modes, not one at the other's expense. Needs many slow runs;
   use marks + loss-split as the signal.
5. **Re-baseline the human target** — 2% is TNC's, not Mirkwood's. A handful of
   real skilled games would tell us whether the bot is 20× too weak or the game
   is just harder than TNC.

## Gotchas

- npm 11 arg-forwarding (see "How to run").
- Rollout wins are too rare to A/B on win rate directly — use intermediate
  metrics.
- Default (`--rollouts 0`) must stay greedy/fast; the game client never imports
  `policy.js`, so tool changes can't affect the live game.

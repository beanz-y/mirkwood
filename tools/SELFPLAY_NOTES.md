# Self-play tool — working notes / handoff

*Written 2026-07-09 at the end of a "make the bot more human-like" session.
Read this before touching `tools/`. High-level context is also in the project
memory; this file is the technical detail a coding session needs.*

---

## UPDATE (2026-07-09 session 4 — bench.js + the tactical pass: planner 23.8→37.6%)

**Measure with `tools/bench.js` from now on.** It runs the fixed config×mode
matrix (same seeds every time → directly comparable), buckets losses into
scarcity/severed/fall, prints binomial σ and `--compare` deltas:

```
node tools/bench.js                                   # greedy+planner, all 3 configs (~15s)
node tools/bench.js --modes planner --games 10000 --compare <ref.json> --out <new.json>
node tools/bench.js --modes plan4 --configs control --games 2000    # rollout milestone (~3-4min)
```

Configs: `control` (cross:40,rune:10,draugr:0, seed 30000) · `mid` (cross:24,
seed 20000) · `normal` (live preset, seed 1000). `tools/bench-baseline.json` =
pre-session state, `tools/bench-current.json` = post-session. Greedy cells
double as a CHECKSUM: they must stay +0.00 unless shared code changed.

**Result: the planner's tactical gap vs greedy is CLOSED and then some.** Ported
greedy's proven terms into `scorePlanMove` one A/B'd term at a time (10k
games/config per probe, ~9s each). Post-session: **control 37.6% (+13.8, 9.6σ)
· mid 1.80% (+0.75, 3.5σ — now >2× greedy) · normal 0.72% (+0.22)**, and
**plan4 (rollouts) on control: ~31% → 45.4%**. Greedy untouched. Tests 136 green.

KEPT (in scorePlanMove unless noted):
- **BFS-aware progress — THE big one (+8.4 pts control, 13σ).** Progress toward
  a.target now uses real road distance when both ends are on the network;
  crow-flies wrapDist only when carving mist. Crow-flies was systematically
  walking souls into walls/dead-end pockets that "point at" the goal.
- **Anti-dither (+2.3 pts, 3.3σ; mid +2σ).** ctx.lastCell was recorded in the
  planner path but never read — souls could oscillate, burning a tile/shuffle.
- **March leak suppression (+2.3 pts, 3.4σ).** Gate-goal moves now score
  destination mouths: toward-gate = road, sideways = stack leak (ported).
- **Rescue/cohesion** (hopeful→dark rescue pull, dark→light pull; +0.5σ mid,
  flat where draugr are absent) and **scarcity-gated guard-light** (only when
  econ.slack < 4 — unconditional was −1.4σ on the circle-rich control) and the
  **hopeless dead-end penalty** (neutral, kept as cheap edge-case cover).
- Rollout branch: **candidate width 3→4** (+0.9σ) and a **stall-breaker**
  (consecutive rollout-chosen Stays get −0.2 each; stalemate concessions 47→13
  per 2000, win-neutral — the bot no longer freezes for 600 turns).

REJECTED — measured red or noise, each has a "don't re-try" note in policy.js:
general no-suicide stay port (−1σ mid, freezes), lateness-scaled fish pull
(−3.1σ control), caravan/mate-proximity (−1.3σ — fights the joint assignment),
assignment hysteresis (−0.9σ — paths evaporate, eager re-solve wins), rollout
weight 0.06→0.10 (noise, slower), fractured-bridge choke-point term (both
signs: noise fast-mode, −1σ in rollout mode — the plan-following rollouts
already price the severed future; if revisited, try it in PLACEMENT).

Everything below this section predates the pass — the planner numbers quoted
there are stale (kept for the reasoning, not the values).

---

## UPDATE (2026-07-09 session 3b — preset + lookahead depth; charge dead)

- **New `normal` preset** (Dan's call, live): straight12/tee32/teeFractured2/
  cross16/rune6/draugr10/2gates = 80 tiles (was 74). Slightly more winnable
  (greedy ~0.1→0.25%). Browser-verified.
- **DEEPER lookahead is a big lever.** On the winnable control (seed 30000, 300
  games): planner+`--rollouts 4` = 27%, **`--rollouts 8` = 38.7%** (+11.7 pts).
  The search is where the strength is (the ML detour proved the same). Use higher
  M for offline strength; cost scales ~linearly (M=4 ≈ 0.47s/game, M=8 ≈ 0.94s).
- **Lean clone** replaced `structuredClone` in `cloneState` — identical rollout
  results (validated: same seed → same win count), ~15% faster. The sim, not the
  clone, is the real rollout cost, so the win is modest but free.
- **Smart Berserk/charge: TRIED, DOESN'T HELP, reverted.** Eager charging HURT
  (Normal 0.31→0.23%); a strict "only banish a draugr on the gate funnel with a
  spare Resolve" version was a no-op (0.31→0.31%). The planner already avoids
  draugr sight-lines, so paying Resolve + a 3-tile self-hit + a hopeless soul to
  remove one is a losing trade. Left a note in `policy.js` so it isn't re-tried.

## UPDATE (2026-07-09 session 3 — the PLANNER beats greedy)

**A multi-turn party planner is the first thing that genuinely outplays greedy.**
Opt-in via `--planner` (`ctx.usePlanner`); greedy stays the default. On the
winnable control (`cross:40,rune:10,draugr:0`) it wins **~21.8% vs greedy's
~19.5%** (≈2.7σ, holds on fresh seeds) — where EVERY greedy tweak this session
(convergence model, rune-priority) *lost*. It cuts the "severed every road"
fragmentation loss, which is the real ceiling.

Why it works: instead of scoring single moves, `computePlan(s, ctx)` assigns
every soul a role each turn — nearest reachable circle for a needed rune (JOINT
1:1, so no two souls chase the same stone and marks come off circles near the
connected road), marked souls converge on the gate doorway, a soul whose light
holds a teammate's circle *guards* it, circle-less souls *fish* toward the gate.
`scorePlanMove` drives each soul to its assigned goal with the party-viability
terms greedy can't coordinate (stay gate-connected, don't crumble a spare
circle). This is `policy.js` → `computePlan` / `scorePlanMove` / `plannerDecision`
(specialises action/attune/post-move; other decisions reuse the greedy handlers).

Caveats / where it still needs work:
- On Normal it's only on-par (~0.13% vs 0.12% — the noise floor / the game's
  hard ceiling), and on the mid config `cross:24` (draugr + scarce circles) it
  slightly *trails* greedy (0.39 vs 0.48): its STRATEGY (assignment) is strong
  but its per-move TACTICS are coarser than greedy's finely-tuned `scoreMove`.
  It shines where ASSEMBLY dominates, trails where scarcity/draugr tactics do.
- **Landmines found & fixed:** adding scarcity "urgency" to the circle-pull
  *tanked* it (winnable 21.8→12%, over-pulls and breaks assembly — REVERTED);
  making Stay a candidate in the *no-rollout* path also tanked it (12%, souls
  stall and burn the tile budget) — Stay is now only a candidate inside the
  rollout branch. The planner's balance is delicate: pull to circles vs hold
  the party together.
- **`--planner --rollouts M` is the strong config — the search adds a LOT.**
  Plan-following rollouts (rolloutToEnd propagates usePlanner; top-3 candidates
  incl. Stay, M rollouts each) take the winnable control from **21% (planner
  greedy) → ~31%** at M=4 (500 games, seed 30000: 157 vs 106 wins, ≈3σ) — greedy
  there is ~19.5%. The bot now *anticipates* where the party's plan ends up. Cost
  ~530ms/game (offline only). Next levers: bump M, widen the candidate set beyond
  top-3, or a proper MCTS tree instead of independent rollouts.

Everything below (the greedy verdict) still stands for the GREEDY bot. The
planner is the path past it — refine `scorePlanMove` tactics + the lookahead.

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
(normal|hard), `--randomRunes`, `--verbose`, `--json <file>`, `--tiles` (override
any tile count — JSON `'{"cross":20}'` OR quote-free `cross:20,tee:32`, the latter
surviving PowerShell), `--rollouts N` (0 = greedy), `--planner` (multi-turn party
planner, else greedy — see the top of this doc), `--params <file|json>` (override
`DEFAULT_PARAMS` weights — inline `'{"march":4}'` or a JSON file), `--quiet`
(suppress the live progress line), `--jobs N` (CPU-parallel — shard the games
across N worker threads; `--jobs auto` = all logical cores). A live progress line
(`done/total · % · running win% · ms/game · elapsed · ETA`) prints to **stderr**
by default, so it never pollutes stdout (`--json`, `| grep`, `2>/dev/null` all
keep working); it updates in place on a terminal and prints one line per tick when
piped to a file.

**`--jobs` (CPU parallelism):** games are seed-deterministic and independent, so
sharding across worker threads gives **identical results** (same wins + loss
histogram) — just ~N× faster. Measured on a 7950X3D: 40k fast games 48.6s→6.8s at
`--jobs 16` (7.2×); the big win is the slow rollout runs (`--planner --rollouts M`
at ~0.5–1.8s/game) which drop from minutes to seconds. NB: `--jobs auto` uses all
*logical* threads (32 on a 16-core SMT chip) and can be *slower* than `--jobs 16`
on short runs (worker startup + SMT oversubscription); **~physical-core count is
the sweet spot** for these compute-bound runs. Workers re-parse the CLI flags
(passed via the Worker `argv`), so `--planner/--rollouts/--tiles/--params` all
propagate; `--json`/summary are written once by the main thread after merging.

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
2. **Global rune-assignment plan** — ~~probably the highest-leverage change~~
   **TRIED 2026-07-09, REVERTED.** Two targeted fixes, both matching a playtest
   spec: (A) an unmarked soul FISHES instead of standing idle while circles remain
   (traced seed 1006: a soul stood fast farming Resolve while the last circle
   burned); (B) marks-FIRST gate commitment so the party never flips off a gate it
   has invested marks in (the bot flipped ~1×/game, orphaning marks → re-attunes).
   **Result: exactly the trade-off this whole doc describes.** Scarcity losses
   −24% and avg marks 2.6→2.8 on Normal — but net wins FLAT (the gained marks
   convert to *severed*/fragmentation losses), and on the winnable control BOTH
   changes lost ~2.4% (20.0%→17.6%) since there's no scarcity to relieve there,
   only the fragmentation cost. Same signature as the reverted convergence model:
   reducing scarcity feeds fragmentation; assembly is the true ceiling. Do NOT
   re-attempt via smarter mark-gathering — the lever is balance, or a genuinely
   better ASSEMBLY strategy (keep the marked party mutually gate-connected), which
   nothing tried so far achieves without over-clustering.
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

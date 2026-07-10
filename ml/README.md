# Mirkwood ML — offline strategy learning

> **STATUS: BANKED (2026-07-09).** Distillation was thoroughly explored and
> shelved. Results on the winnable control (`cross:40,rune:10,draugr:0`): raw
> imitation 0.3% → +plan-conditioning 5.7% → +plan-DAgger(5) 9.8% → bigger net
> 9.0% (overfit). The planner+search bot (`tools/policy.js --planner --rollouts`,
> ~21%/31%) is the shipped playtest bot — a learned REACTIVE net can't reproduce
> its coordinated, *searched* policy (val move-predictability caps ~72%; the
> intelligence is in the search, not any function of the board). To EXCEED the
> planner you need net + MCTS (AlphaZero) — not attempted. **If resumed:** the
> plan-conditioned net (`ml/model_plan.onnx`, ~10%) is a decent RL warm-start;
> everything below still runs. Pipeline verified end-to-end on this machine
> (torch/DirectML/onnx). See `tools/SELFPLAY_NOTES.md` for the heuristic story.



*Started 2026-07-09. This directory is **offline-only** — it is NEVER deployed.
A `git push` to main ships only the Worker (`worker/index.js` + its imports) and
`public/`; `ml/` (like `tools/` and `test/`) is invisible to Cloudflare. Nothing
here can affect the live game.*

## Why & what

Rapid, solo playtesting: train a bot stronger than the hand-written heuristic so
win-rate / balance experiments run in software instead of needing a big human
group. Later, the learned net can drop into the browser/Worker as a live AI
player. See `tools/SELFPLAY_NOTES.md` for the heuristic baselines this builds on.

## Architecture — the engine stays JS; Python only does the ML

```
  engine.js  ──imports──►  tools/policy.js (heuristic bot: greedy + planner + search)
   (JS, the        │                 │
   single source   │                 ▼
   of truth)       │        ml/gen_data.mjs  ──► training data (features, move, outcome)
                   │         (Node self-play)          │  data/*.jsonl
                   │                                    ▼
                   │                         ml/train.py (PyTorch)  ──► model.onnx
                   │                                    │
                   └────────── Node + onnxruntime ◄─────┘   (Phase 2: net self-plays)
                                                            (Phase 3: same .onnx → browser/Worker)
```

**No engine port.** The engine runs in JS everywhere (self-play data gen, RL
self-play, and eventually the live game). Python trains; the net crosses the
boundary as **ONNX**. Zero divergence, and the artifact is already JS-runnable.

## Scope of the net (first cut)

The net decides **movement only** — for an `action` decision it outputs a
distribution over `[N, E, S, W, stay]` (+ a value head = win probability). Tile
placement / niflheim removal / attune stay on the heuristic for now (movement is
where the game is won or lost). This keeps the action space tiny (5) and the
ONNX export trivial to run in JS.

## Feature encoding (`encode.mjs`)

A flat `Float32` vector per (state, deciding-soul): 36 board cells × ~20 per-cell
features (has-tile, 4 exits, kind one-hot, fractured, spent, rift, lit, occupancy
by me/other/hopeful) + global scalars (stack composition, niflheim/phase,
per-soul placed/hopeful/resolve/rune-gate, marks-per-gate, circles left, awaiting
type, deciding seat). Flat → a small MLP → trivial ONNX → trivial JS inference.
(Can upgrade to 6×6 CNN planes with circular padding for the toroidal board if
the MLP plateaus.)

## Phases / milestones

1. **Imitation** — `gen_data.mjs` → `train.py` clones the bot's movement + value.
   **Result: insufficient alone.** The net reached 53% move-match but plays at
   only ~0.3% (bot ~21% on the winnable variant): plain behavioural cloning
   suffers COMPOUNDING ERROR — small per-move disagreements push the party into
   states the bot never visited, and a reactive per-soul net loses the planner's
   JOINT coordination. Diagnosed (on-policy net~bot agreement drops to 48%), not
   a bug. Pipeline is sound and reused below.
1b. **DAgger** (`dagger_gen.mjs` + `dagger.sh`) — the fix: the NET drives (so we
   collect its own trajectory), but every state is LABELLED by the bot; aggregate
   with D0 and retrain; iterate. Makes the net robust on its own distribution.
   Milestone: net win-rate climbs toward the bot → a fast (~µs) bot + an RL
   warm-start. `bash ml/dagger.sh 4` (logs to `ml/dagger.log`).
2. **Self-improve (RL)** — from the DAgger warm-start, net self-plays via
   `onnxruntime-node`, expert-iteration / policy-gradient with the shaped reward
   (marks + connectivity + home + win) + a difficulty curriculum. Milestone: net
   > bot.
3. **Transfer** — the same `model.onnx` runs in `client.js` / the Worker as a
   live AI player (separate product decision; nothing auto-ships).

## Setup (already present on this machine)

`py -m pip list` shows torch 2.4.1, torch-directml 0.2.5, onnxruntime, numpy,
numba. Training defaults to **CPU** (the net is tiny); to use the 7900 XTX:
`import torch_directml; dev = torch_directml.device()`. Node self-play needs
`npm i onnxruntime-node` (added at Phase 2).

## Run

```
node ml/gen_data.mjs --games 5000 --planner --out ml/data/imitation.jsonl
py ml/train.py --data ml/data/imitation.jsonl --out ml/model.onnx      # Phase 1 (next)
```

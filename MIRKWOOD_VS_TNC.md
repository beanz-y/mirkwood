# Mirkwood vs *The Night Cage* — rules diff & difficulty levers

*Written 2026-07-09. Ground truth: `RULES.md` + `public/shared/engine.js` for
Mirkwood; the retail **TNC rulebook PDF** (`TNC_RuleBook_201005LR.pdf`, 20pp) for
The Night Cage. Purpose: turn the self-play finding ("the win-rate ceiling is the
game, not the bot") into concrete, TNC-anchored dials Dan can actually turn.
Companion to `RULES.md` (which lists Mirkwood's departures) and
`tools/SELFPLAY_NOTES.md` (the ceiling evidence).*

---

## The one-line lineage

Mirkwood is a Norse reskin **and rework** of TNC's core loop (explore a wrapping
6×6 grid by candle/ember-light; paths vanish behind you; collect tokens, then
assemble the whole party on one gate). **The tile counts are byte-identical to
TNC's 1–4 player setup except Mirkwood has 2 gates where TNC has 4.** Everything
else that makes Mirkwood harder is a *rules* change, not a tile-count change —
which is exactly why the self-play bot's losses concentrate in **assembly**
(getting the whole marked party onto a gate before the board dies), not in tile
scarcity.

| | TNC 1–4p draw stack | Mirkwood normal |
|---|---|---|
| Straight | 10 | 10 |
| "T" / forking | 32 (2 crumbling) | 32 (2 fractured) |
| 4-way / cross | 12 | 12 |
| Key / Rune Circle | **6** | **6** |
| Monster (Wax Eater / Draugr) | 12 | 12 |
| **Gate** | **4** | **2** |
| ~total | ~76 | 74 |

---

## Side-by-side: every mechanical difference

▲ = harder in Mirkwood · ▼ = easier in Mirkwood · ● = equivalent

| Dimension | The Night Cage | Mirkwood | Dir |
|---|---|---|---|
| Board / wrap | 6×6 wrap (7×7 at 5p) | 6×6 wrap | ● |
| Souls | Always 4 (dummies fill) | Always 4 | ● |
| Light radius | Candle, 1 tile | Ember, 1 tile | ● |
| Draw stack = timer | yes; opens with 8 safe tiles | yes; opens with 8 safe tiles | ● |
| **Collectible** | **Key** — generic, interchangeable | **Rune** — typed to a gate (4 per gate) | ▲ |
| Collect requirement | each of 4 prisoners holds **any** 1 key | 4 souls hold **4 distinct runes of one gate** | ▲ |
| **Passing collectibles** | **Keys pass** between adjacent prisoners (free) | **No passing** — each soul must attune in person | ▲▲ |
| Must personally reach a token? | No — one prisoner can ferry keys to the others | **Yes — all four must each walk to a circle** | ▲▲ |
| Tokens available vs needed | 6 keys, need 4 | 6 circles, need 4 | ● |
| Choose which token value? | n/a (keys identical) | pick any rune at any circle (or Random-Runes variant) | ● |
| **Gates** | **4** on the board | **2** | ▲ |
| Gate permanence | losable to darkness any time | **permanent once placed** (mist/Niflheim can't take it) | ▼ |
| Monster count | 12 Wax Eaters | 12 Draugar | ● |
| Monster trigger | motion in a straight connected corridor, all 4 dirs, wraps | identical | ● |
| Monster strike | 3 tiles burned + **Lights Out**, per victim | 3 tiles + **Hopeless**, per victim | ● |
| Chain reactions | yes | yes | ● |
| **Monster removal** | Charge doesn't remove it; only fades when unlit / fallen-onto | **Berserk BANISHES it** (a true removal tool) | ▼ |
| Evade = resource | move out of line → miss + (implicitly) safe | move out of line → miss **+1 Resolve** | ▼ |
| Fall landing state | lands LIT (re-illuminates around them) | lands LIT *(as of 2026-07-09; was Hopeless — reverted to TNC)* | ● |
| Self-relight | none — only auto-relit by an adjacent lit ally | **Rekindle**: spend 1 Resolve to relight yourself | ▼ |
| Fall landing choice | commit to row **or** column when you fall | choose row **or** column at *landing* time | ▼ |
| Nerve / Resolve | start 1, max 2; Stay +1 | start 1, max 2; Stay +1 (+1 on evade) | ● |
| Endgame trigger | stack empty → **Final Flickers** | stack empty → **Niflheim's Embrace** | ● |
| Endgame tile removal | 1/turn, **player's choice of tile**, Sustain to skip | 1/turn, player's choice, **Ward** to skip | ● |
| **"You're cut off" loss** | **none** — you play the dwindling board out until you physically can't | **severed-road AUTO-LOSS** each turn once a gate is unreachable-by-all | ▲ |
| **Token-scarcity loss** | implicit ("cannot each collect a Key") — discovered by playing | **explicit auto-loss** the moment circles can't complete the set | ▲ |
| Fall-with-empty-stack loss | when you actually can't draw to land | declared **at the fall** (same outcome, sooner) | ● |
| Difficulty knobs (per rulebook) | "remove/add a **Key or Gate**" — designer-stated | same knobs exist (`--tiles`) | ● |

### Advanced/boss content TNC has and Mirkwood doesn't (yet)
Keepers (key-bearing persistent monsters), Pit Fiends (diagonal board-destroyers),
The Dirge (9-tile omen-heralded boss), The Pathless (wall-piercing 5-tile strike).
Already earmarked as Mirkwood's future "Advanced game" (Garm/Níðhöggr/Hel's Herald
in HANDOFF). Not difficulty *levers* — they're expansions.

---

## Net read

**Mirkwood is meaningfully harder than TNC, and the extra difficulty is almost
entirely in ASSEMBLY, not exploration or scarcity.** Same board, same timer, same
6-of-6→4 token math, same 12 monsters. What changed all pushes the same way:

- **No key passing + typed runes + personal circle visits** → all four souls must
  each trek to a circle *and* then all converge on one gate. TNC lets a mobile
  prisoner ferry keys, so prisoners can gather at a gate early and receive keys
  there. This is the single biggest divergence and it *directly* produces the
  self-play bot's dominant loss ("the cold has severed every road" — the party
  fragments and can't reconverge).
- **2 gates instead of 4** → half as many assembly targets, higher chance both
  are lost, and the party can't opportunistically pick the nearest of four.
- ~~**Land Hopeless on a fall**~~ → **reverted to TNC's land-lit (2026-07-09)**;
  falls no longer trigger the Rekindle-tax / rescue-detour cascade.
- **Two explicit auto-losses** (severed-road, rune-scarcity) → Mirkwood *ends*
  games TNC would let you grind out. These only fire when the position is truly
  dead per the engine's reachability check, so they mostly convert "obviously
  lost, still shuffling" into a clean end — but they also remove TNC's "play it
  out and maybe scrape it" tail.

Mirkwood's *easier* departures (Berserk banish, permanent gates, Rekindle,
row-or-column landing, evade-Resolve) partly offset the fall penalty and monster
threat, but they don't touch the assembly problem — so the net is harder.

And note the rulebook's own words: **"THE NIGHT CAGE is intended to be difficult
to win."** The ~2% human number Dan quoted is a *by-design* TNC figure; Mirkwood,
harder at assembly, should sit **below** it. That reframes the self-play ceiling:
0.1% for a greedy bot vs a low-single-digit human ceiling on a game deliberately
built to be brutal is plausible, not evidence of a broken bot.

---

## What we can affect — tuning levers, ranked

### Measured first (self-play, 20k games each, greedy bot)

The bot-measurable dials **compound multiplicatively** — the two the TNC rulebook
itself names (token count) plus the master clock (tile budget) take the greedy
party from the noise floor into the low-single-digit human band with **zero rules
changes**:

| Config | Win rate | vs baseline |
|---|---|---|
| Baseline (2 gate, rune 6) | 0.13% | — |
| Rune 6 → 8 | 0.34% | ~2.6× |
| Stack +8 tiles (`cross:20`) | 0.33% | ~2.6× |
| Stack +16 tiles (`cross:28`) | 0.69% | ~5× |
| **Rune 8 + stack +16** | **1.48%** | **~11×** |

**Caveat on the gate count:** adding a 3rd gate measured as *no change* (0.11%),
but that is a **bot artifact, not a verdict** — `policy.js`'s `gateApproach` only
ever targets the *first* gate tile of its pantheon, so the bot literally cannot
use a second one. Humans would route to whichever gate is reachable. To measure
this lever honestly, first teach the bot to aim at the *nearest reachable* gate of
its set (small `policy.js` change), or judge it by playtest.

Each lever notes the TNC baseline, the change, expected effect, and **how to
measure it** (whether the self-play harness can test it *today* via `--tiles`, or
needs a small engine change first). Measure every change with
`node tools/selfplay.js --games 40000 [--tiles …] [--params …]` before/after, and
read the **loss-reason split** (scarcity vs severed vs falls), not just the noisy
win rate. The winnable-control variant (`--tiles '{"draugr":0,"rune":10,"cross":40}'`,
~20% wins) is the sensitive gauge when Normal is too close to the noise floor.

1. **Add a 3rd gate (`--tiles '{"gateFolkvangr":2}'` or a 3rd pantheon).**
   TNC=4, Mirkwood=2. The rulebook names gate count a primary dial; more gates =
   more assembly targets + lower both-lost risk. **Unproven by self-play** — the
   bot's single-gate targeting can't use it (see caveat above); needs a small
   `gateApproach` upgrade or a playtest to judge. Conceptually the closest fix to
   TNC and to the *assembly* failure mode, so worth the bot change to test.

2. **Allow rune passing / mark transfer between adjacent souls.** TNC passes keys
   freely; `RULES.md` departure #5 *already* flags this as the intended safety
   valve. This attacks the fragmentation loss at its root — a soul who reaches a
   circle can hand its mark to a straggler at the gate. **Needs an engine action**
   (`transfer` to an adjacent connected soul) + a small policy branch, then A/B.
   *Highest expected impact on the actual failure mode.*

3. ~~**Land LIT instead of Hopeless.**~~ **DONE (2026-07-09).** `landSoul` now
   lands the faller Hopeful (kindles anew), matching TNC. Measured wash-to-slight-
   help (avg marks 2.6→2.7); it trades the fragmentation-cascade for a little more
   stack-burn (the faller kindles on landing). `RULES.md` #8 updated.
   *Note: removing evade-Resolve was considered alongside it but **rejected** —
   TNC-faithful but measurably harder (marks 2.7→2.5), and Mirkwood is already
   harder than TNC.*

4. **Raise the rune-circle count (`--tiles '{"rune":8}'`).** The rulebook's other
   stated dial ("+1–2 keys makes a big difference"). **Measured ~2.6× on its own**
   (0.13→0.34%) and it compounds with #5 (rune8+stack16 = 1.48%). Testable now,
   proven, and cheap. A real knob, not just a fine-tune.

5. **Soften the endgame clock (the master timer) — the strongest proven dial.**
   Win rate scales with the *tile budget*: **+8 tiles ≈ 2.6×, +16 ≈ 5×**, and the
   winnable control went 3%→20% at +28. Options, cheapest first: **+8–16 crossings
   in the stack** (`--tiles '{"cross":20/28}'`, *testable now*); remove a tile
   every *other* turn during the Embrace; or start the Embrace with a few "grace"
   turns before removals begin (both a small change in `end-turn`, engine). This
   is the biggest lever but it changes the game's *feel* (a longer, less-tense
   endgame) the most — dial with playtest taste, not just win rate.

6. **Relax the severed-road auto-loss (grace / less aggressive).** Give the party
   a turn or two after the check first fails before conceding, or only auto-lose
   when no Ward-spend or rift-crossing could restore a path. **Engine change** in
   `embraceDoomCheck`. *Lowest priority — it mostly ends already-lost games; it
   won't create wins, only length. Worth it only if playtesters find the instant
   concession unsatisfying.*

### Recommended sequence
Proven-and-cheap first: **#4 (rune 8) + #5 (a few extra crossings)** are testable
today and already reach ~1.5% (low human band) with no rules change — start there.
Then the *rules-authentic* assembly fixes that target the actual failure mode:
**#2 (rune passing)** and **#3 (land lit)**, each a small engine change measured
before/after. **#1 (3rd gate)** needs the bot's `gateApproach` upgraded before
self-play can score it — do that if you want to lean toward TNC's 4-gate feel.
Reserve **#6** for a playtest complaint about the instant concession.

**Before committing any of this:** log **one real skilled-human Mirkwood game**
(telemetry is live) to set the true target — the ~2% is a *TNC* number, and this
doc shows Mirkwood is harder, so the honest target is probably lower.

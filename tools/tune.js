/*
 * Mirkwood policy weight tuner — Cross-Entropy Method (CEM).
 *
 *   node tools/tune.js --iters 12 --pop 28 --elite 7 --games 1500 --out tools/params.tuned.json
 *   node tools/tune.js --preset hard --iters 10
 *   node tools/tune.js --tiles '{"rune":8}'          # tune on a variant
 *
 * The party's brain (tools/policy.js) exposes DEFAULT_PARAMS — the ~19 weights
 * that drive movement, mark-gathering and convergence. This searches that space
 * with CEM: sample a population of weight vectors from a Gaussian, score each by
 * playing many headless games, keep the elite, refit the Gaussian to the elite,
 * repeat. The mean marches toward the best-performing region.
 *
 * WHY A SHAPED REWARD, NOT WIN RATE: strong play wins Mirkwood only ~0.2% on
 * Normal, far too rare to rank candidates by (4 wins in 2000 games is noise).
 * Instead each game returns a DENSE terminal reward — souls brought home, marks
 * gathered, near-win states — that peaks only at the true win condition and has
 * low variance, so candidates separate cleanly. A real win still scores 1.0
 * (dwarfing any loss), so the search is pulled toward actually winning, not just
 * toward a comfortable-looking frontier.
 *
 * WHY COMMON RANDOM NUMBERS: every candidate in an iteration plays the SAME seed
 * block, so score differences reflect the weights, not luck. A separate held-out
 * seed block validates the winner at the end (guards against overfitting the
 * training seeds).
 *
 * No network, no Firebase — pure local simulation against the real engine.
 */
import { createGame, applyAction, TILE_PRESETS, normTiles } from '../public/shared/engine.js';
import { policy, mulberry, tilesOf, DEFAULT_PARAMS } from './policy.js';
import { key, SIZE, OPP, stepDir } from '../public/shared/engine.js';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------- CLI
const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const ITERS = +opt('iters', 12);
const POP = +opt('pop', 28);
const ELITE = +opt('elite', 7);
const GAMES = +opt('games', 1500);
const BASE_SEED = +opt('seed', 5000);
const PRESET = opt('preset', 'normal');
const RANDOM_RUNES = flag('randomRunes');
const SIGMA0 = +opt('sigma', 0.5);          // initial std as a fraction of |mean|
const OUT = opt('out', 'tools/params.tuned.json');
const TILE_OVERRIDE = opt('tiles', null) ? JSON.parse(opt('tiles', null)) : null;
const ROLLOUTS = +opt('rollouts', 0);

const baseTiles = { ...(TILE_PRESETS[PRESET] || normTiles({})), ...(TILE_OVERRIDE || {}) };

// ---------------------------------------------------------------- search space
// Every DEFAULT_PARAMS key is tunable. Bounds keep candidates sane (weights that
// must stay non-negative, clock params in a plausible tile range).
const KEYS = Object.keys(DEFAULT_PARAMS);
const BOUNDS = {
  victim: [4, 30], fractureLate: [0, 15],
  runeReach: [4, 45], runeUrg: [0, 20], onRune: [0, 20],
  gateFishBase: [0, 8], gateFishLate: [0, 8],
  march: [0, 12], marchAll: [0, 16], assembly: [0, 40], nearGate: [0, 25],
  caravan: [0, 8], straggler: [0, 20], rescueLate: [0, 12],
};
const bound = k => BOUNDS[k] || [0, 100];
const clampP = (k, v) => { const [lo, hi] = bound(k); return Math.max(lo, Math.min(hi, v)); };

// ---------------------------------------------------------------- game runner + shaped reward

// distinct marks the party holds for gate g
function marksFor(s, g) {
  return new Set(s.players.filter(q => q.rune && q.rune.p === g).map(q => q.rune.k)).size;
}
// BFS over connected passages from a gate cell → which souls still have a road home
function homeAndConnected(s, gr, gc) {
  const dist = new Map([[key(gr, gc), 0]]);
  const q = [[gr, gc]];
  const cellAt = (r, c) => s.grid[key(r, c)];
  while (q.length) {
    const [r, c] = q.shift();
    const cl = cellAt(r, c); const t = cl && cl.tile;
    if (!t) continue;
    for (let d = 0; d < 4; d++) {
      if (!t.exits[d]) continue;
      const [nr, nc] = stepDir(r, c, d);
      const ncl = cellAt(nr, nc);
      if (!ncl || !ncl.tile || !ncl.tile.exits[OPP(d)] || dist.has(key(nr, nc))) continue;
      dist.set(key(nr, nc), 0); q.push([nr, nc]);
    }
  }
  const gset = new Set(tilesOf(s, 'gate', undefined)
    .filter(([r, c]) => { const t = s.grid[key(r, c)].tile; return t.gate === s.grid[key(gr, gc)].tile.gate; })
    .map(([r, c]) => key(r, c)));
  let home = 0, conn = 0;
  for (const p of s.players) {
    if (!p.placed) continue;
    if (gset.has(key(p.r, p.c))) home++;
    else if (dist.has(key(p.r, p.c))) conn++;
  }
  return { home, conn };
}

// Terminal reward in ~[0,1]. A win is 1.0 and dwarfs everything. Losing lines get
// a dense gradient dominated by souls actually brought HOME to the gate (the
// scarcest, most win-correlated signal), then marks, then mere connectivity, with
// a bump for one-step-from-winning states.
function terminalReward(s) {
  if (s.phase === 'won') return 1.0;
  let best = 0;
  for (const g of ['valhalla', 'folkvangr']) {
    const gs = tilesOf(s, 'gate', g);
    const m = marksFor(s, g);
    let home = 0, conn = 0;
    if (gs.length) ({ home, conn } = homeAndConnected(s, gs[0][0], gs[0][1]));
    // graduated near-win gradient: "how close did we get" is a MUCH lower-variance
    // proxy for winning than the ~0.2% win event itself, and pulls the search
    // toward configs that reach one-step-from-home states more often.
    let bump = 0;
    if (m === 4 && home >= 3) bump = 0.16;
    else if (m === 4 && home >= 2) bump = 0.09;
    else if (m >= 3 && home >= 2) bump = 0.04;
    const r = 0.08 * m + 0.12 * home + 0.03 * conn + bump;
    if (r > best) best = r;
  }
  return best;
}

function playGame(seed, params) {
  const rnd = mulberry(seed * 7 + 3);
  const ctx = { rollouts: ROLLOUTS, params };
  const s = createGame({ seed, tiles: baseTiles, randomRunes: RANDOM_RUNES });
  let steps = 0, empty = 0;
  while (s.phase !== 'won' && s.phase !== 'lost') {
    empty = s.stack.length === 0 ? empty + 1 : 0;
    if (++steps > 6000 || empty > 600) { s.phase = 'lost'; break; }
    applyAction(s, s.awaiting.seat, policy(s, rnd, ctx));
  }
  return { won: s.phase === 'won', reward: terminalReward(s) };
}

// mean shaped reward + win count over a seed block (common random numbers)
function evaluate(params, seed0, n) {
  let sum = 0, wins = 0;
  for (let i = 0; i < n; i++) {
    const r = playGame(seed0 + i, params);
    sum += r.reward; if (r.won) wins++;
  }
  return { fitness: sum / n, wins, winRate: 100 * wins / n };
}

// ---------------------------------------------------------------- CEM

function gaussSampler(seed) {
  const rnd = mulberry(seed);
  let spare = null;
  return () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

function vecFrom(obj) { return KEYS.map(k => obj[k]); }
function objFrom(vec) { const o = {}; KEYS.forEach((k, i) => o[k] = vec[i]); return o; }

const t0 = Date.now();
const gauss = gaussSampler(1234567);
let mean = vecFrom(DEFAULT_PARAMS);
let std = KEYS.map((k, i) => Math.max(0.05, SIGMA0 * Math.abs(mean[i])) || 0.3);

console.log(`=== CEM tuning (preset=${PRESET} tiles=${JSON.stringify(baseTiles)}) ===`);
console.log(`iters=${ITERS} pop=${POP} elite=${ELITE} games/eval=${GAMES} keys=${KEYS.length}`);
console.log(`baseline (DEFAULT_PARAMS): ` + JSON.stringify(evaluate(DEFAULT_PARAMS, BASE_SEED, GAMES)));

let bestEver = { fitness: -Infinity, params: objFrom(mean) };

for (let it = 0; it < ITERS; it++) {
  // sample a population around the current Gaussian (candidate 0 = current mean)
  const pop = [];
  for (let n = 0; n < POP; n++) {
    const v = mean.map((mu, i) => n === 0 ? mu : clampP(KEYS[i], mu + std[i] * gauss()));
    pop.push(v);
  }
  // score every candidate, every iteration, on the SAME fixed seed block so
  // fitness is comparable across the whole run (common random numbers). The
  // held-out block at the end guards against overfitting this block.
  const seed0 = BASE_SEED;
  const scored = pop.map(v => {
    const ev = evaluate(objFrom(v), seed0, GAMES);
    return { v, ...ev };
  });
  scored.sort((a, b) => b.fitness - a.fitness);
  const elite = scored.slice(0, ELITE);

  // refit mean/std to the elite, with a small std floor so it doesn't collapse
  mean = KEYS.map((k, i) => elite.reduce((acc, e) => acc + e.v[i], 0) / ELITE);
  std = KEYS.map((k, i) => {
    const mu = mean[i];
    const varr = elite.reduce((acc, e) => acc + (e.v[i] - mu) ** 2, 0) / ELITE;
    return Math.max(Math.sqrt(varr), 0.03 * Math.abs(mu) + 0.02);
  });

  const meanObj = objFrom(mean);
  const meanEv = evaluate(meanObj, seed0, GAMES); // score the refit mean on same block
  if (meanEv.fitness > bestEver.fitness) bestEver = { fitness: meanEv.fitness, params: meanObj, winRate: meanEv.winRate };
  const top = elite[0];
  console.log(
    `iter ${String(it + 1).padStart(2)}  eliteBest fit=${top.fitness.toFixed(4)} win=${top.winRate.toFixed(2)}%` +
    `  mean fit=${meanEv.fitness.toFixed(4)} win=${meanEv.winRate.toFixed(2)}%  (${((Date.now() - t0) / 1000).toFixed(0)}s)`
  );
}

// ---------------------------------------------------------------- validate + write
console.log('\n=== validation (held-out seed block) ===');
const HELD = BASE_SEED + 1_000_000;
const bDef = evaluate(DEFAULT_PARAMS, HELD, GAMES * 3);
const bBest = evaluate(bestEver.params, HELD, GAMES * 3);
console.log(`DEFAULT_PARAMS : fit=${bDef.fitness.toFixed(4)}  win=${bDef.winRate.toFixed(2)}%  (${bDef.wins} wins)`);
console.log(`tuned (best)   : fit=${bBest.fitness.toFixed(4)}  win=${bBest.winRate.toFixed(2)}%  (${bBest.wins} wins)`);

const rounded = {};
for (const k of KEYS) rounded[k] = Math.round(bestEver.params[k] * 1000) / 1000;
writeFileSync(OUT, JSON.stringify(rounded, null, 2) + '\n');
console.log(`\nbest params written to ${OUT}`);
console.log(JSON.stringify(rounded));
console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(0)}s`);

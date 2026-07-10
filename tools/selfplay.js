/*
 * Mirkwood self-play balance harness (policy v2 — cooperative).
 *
 *   node tools/selfplay.js --games 500 --preset hard --randomRunes --seed 7
 *   node tools/selfplay.js --games 1000 --json results.json
 *
 * Plays full games headlessly against the real engine (the same file the
 * deployed Worker runs) with a COOPERATIVE heuristic party and prints outcome
 * statistics. No server, no network, no Firebase — pure local simulation.
 *
 * Human benchmark: Dan & wife have won The Night Cage ~2 times in 100+ games,
 * so a well-balanced Mirkwood should sit in the low single digits for strong
 * play. If the bot exceeds that comfortably, the game is too easy; if a
 * well-tuned bot can NEVER win, suspect the economy.
 *
 * Policy principles (per playtest direction):
 *  1. Full cooperation — one shared plan; nobody optimizes selfishly.
 *  2. Commit early to a single gate's pantheon; runes are assigned distinctly.
 *  3. Placement is draugr-aware: avoid extending sight lanes, weight open
 *     lanes by the live probability of drawing a Draugr, wall off known
 *     monsters, and place forced Draugr where they see the fewest souls.
 *  4. Never take a move that triggers a strike on teammates; evade
 *     deliberately (for Resolve) only when nobody else stands in the lane.
 *
 * The party plays with open information (matching the physical game: the
 * whole table sees the board and the public discard; only the stack ORDER is
 * hidden, and this policy never peeks at order — only at remaining counts,
 * which mirror the public discard tracker).
 */
import {
  createGame, applyAction, losFor, RUNES, TILE_PRESETS, normTiles,
  SIZE, key, OPP, exitsFor, stepDir,
} from '../public/shared/engine.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { isMainThread, Worker, workerData, parentPort } from 'node:worker_threads';
import { cpus } from 'node:os';

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const flag = name => args.includes('--' + name);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const GAMES = +opt('games', 200);
const BASE_SEED = +opt('seed', 1000);
const PRESET = opt('preset', 'normal');
const RANDOM_RUNES = flag('randomRunes');
const VERBOSE = flag('verbose');
const QUIET = flag('quiet'); // suppress the live progress line (stderr)
// CPU-parallel self-play: shard the games across N worker threads (--jobs auto =
// all cores). Games are seed-deterministic, so results are IDENTICAL to a single
// thread — just ~N× faster. Default 1 (unchanged behaviour).
const JOBS = (() => { const v = opt('jobs', '1'); return v === 'auto' ? cpus().length : Math.max(1, Math.floor(+v) || 1); })();
const JSON_OUT = opt('json', null);
const ROLLOUTS = +opt('rollouts', 0); // >0 → rollout lookahead per move (slower, smarter)
const USE_PLANNER = flag('planner'); // opt-in multi-turn party planner (else greedy)
// balance experiments: override any tile counts. Accepts real JSON
// (--tiles '{"rune":7}') OR a quote-free list (--tiles cross:20,tee:32) so it
// survives PowerShell, which strips the inner double quotes from JSON args.
function parseTiles(str) {
  if (!str) return null;
  str = str.trim();
  try { return JSON.parse(str); } catch { /* fall through to lenient parse */ }
  const out = {};
  for (const pair of str.replace(/^\{|\}$/g, '').split(',')) {
    if (!pair.trim()) continue;
    const [k, v] = pair.split(/[:=]/);
    const key = (k || '').trim().replace(/['"]/g, '');
    const val = Number((v || '').trim());
    if (key && Number.isFinite(val)) out[key] = val;
  }
  if (!Object.keys(out).length) throw new Error(`could not parse --tiles "${str}" (use cross:20,tee:32 or '{"cross":20}')`);
  return out;
}
const TILE_OVERRIDE = parseTiles(opt('tiles', null));
// gate doorway variant: one (live rule) | straight | tee — balance experiments
const GATE_EXITS = opt('gateExits', 'one');

// policy + shared helpers live in tools/policy.js — tune the party there
import { policy, hasGoodMark, mulberry, tileAt, tilesOf, DEFAULT_PARAMS } from './policy.js';

// weight overrides for the tuner / experiments: --params '{"convPull":4,...}'
// or --params <file.json> (the CEM tuner writes best params there)
const PARAMS_ARG = opt('params', null);
let PARAMS = null;
if (PARAMS_ARG) {
  const raw = PARAMS_ARG.trim().startsWith('{')
    ? PARAMS_ARG
    : readFileSync(PARAMS_ARG, 'utf8');
  PARAMS = { ...DEFAULT_PARAMS, ...JSON.parse(raw) };
}

// ---------------------------------------------------------------- runner

function playGame(seed) {
  const rnd = mulberry(seed * 7 + 3);
  const ctx = { rollouts: ROLLOUTS };
  if (PARAMS) ctx.params = PARAMS;
  if (USE_PLANNER) ctx.usePlanner = true;
  const s = createGame({
    seed,
    tiles: { ...(TILE_PRESETS[PRESET] || normTiles({})), ...(TILE_OVERRIDE || {}) },
    randomRunes: RANDOM_RUNES,
    gateExits: GATE_EXITS,
  });
  let steps = 0, emptyStackSteps = 0;
  let circlesRevealed = 0, attunes = 0;
  while (s.phase !== 'won' && s.phase !== 'lost') {
    emptyStackSteps = s.stack.length === 0 ? emptyStackSteps + 1 : 0;
    if (++steps > 6000 || emptyStackSteps > 600) {
      s.phase = 'lost';
      s.lossReason = 'stalemate — the souls are cut off from the gate (harness concession)';
      break;
    }
    applyAction(s, s.awaiting.seat, policy(s, rnd, ctx));
    for (const e of s.events) {
      if (e.e === 'rune') attunes++;
      if (e.e === 'reveal') {
        const t = tileAt(s, e.r, e.c);
        if (t && t.kind === 'rune') circlesRevealed++;
      }
    }
  }
  const circlesInStack = s.stack.filter(t => t.kind === 'rune').length;
  return {
    seed,
    result: s.phase,
    lossReason: s.lossReason || '',
    turns: s.turnsTaken,
    stackLeft: s.stack.length,
    goodMarks: s.players.filter(p => hasGoodMark(s, p, ctx.plan || 'valhalla')).length,
    circlesRevealed,
    attunes,
    circlesBurnedInStack: Math.max(0, 6 - circlesRevealed - circlesInStack),
    planFlips: ctx.flips || 0,
    planGateOnBoard: tilesOf(s, 'gate', ctx.plan).length > 0,
    planGateInStack: s.stack.some(t => t.kind === 'gate' && t.gate === ctx.plan),
  };
}

// live progress → STDERR (never pollutes stdout: --json, `| grep`, `2>/dev/null`
// all keep working). Updates in place on a TTY, one line per tick when piped.
const showProgress = !QUIET && !VERBOSE;
const isTTY = process.stderr.isTTY;
function progressLine(done, total, wins, elapsedMs, errs) {
  const per = elapsedMs / done, eta = per * (total - done) / 1000;
  const line = `  ${done}/${total} ${(100 * done / total).toFixed(0)}%`
    + ` · wins ${wins} (${(100 * wins / done).toFixed(2)}%)`
    + ` · ${per < 20 ? per.toFixed(2) : per.toFixed(0)}ms/game`
    + ` · ${(elapsedMs / 1000).toFixed(0)}s elapsed · ETA ${eta.toFixed(0)}s`
    + (errs ? ` · ${errs} err` : '') + '    ';
  process.stderr.write(isTTY ? '\r' + line : line + '\n');
}
function report(results, errors, ms) {
  const wins = results.filter(r => r.result === 'won');
  const losses = results.filter(r => r.result === 'lost');
  const avg = (arr, f) => arr.length ? (arr.reduce((n, x) => n + f(x), 0) / arr.length).toFixed(1) : '-';
  const reasons = {};
  for (const r of losses) {
    const short = r.lossReason.split('—')[0].split('.')[0].trim().slice(0, 60);
    reasons[short] = (reasons[short] || 0) + 1;
  }
  const summary = {
    policy: 'v2-cooperative', preset: PRESET, randomRunes: RANDOM_RUNES, gateExits: GATE_EXITS,
    games: results.length, errors, jobs: JOBS, wins: wins.length,
    winRate: +(100 * wins.length / Math.max(1, results.length)).toFixed(2),
    avgTurns: +avg(results, r => r.turns), avgStackLeft: +avg(results, r => r.stackLeft),
    avgGoodMarks: +avg(results, r => r.goodMarks), lossReasons: reasons,
    msPerGame: +(ms / Math.max(1, results.length)).toFixed(2),
  };
  console.log('\n=== Mirkwood self-play (policy v2 — cooperative) ===');
  console.log(`preset=${PRESET} randomRunes=${RANDOM_RUNES}${GATE_EXITS !== 'one' ? ` gateExits=${GATE_EXITS}` : ''} games=${results.length} errors=${errors} (${ms}ms, ${summary.msPerGame}ms/game${JOBS > 1 ? `, ${JOBS} jobs` : ''})`);
  console.log(`wins: ${wins.length}  (${summary.winRate}%)`);
  console.log(`avg turns: ${summary.avgTurns}   avg stack left: ${summary.avgStackLeft}   avg matching marks at end: ${summary.avgGoodMarks}`);
  console.log(`circle economy: revealed ${avg(results, r => r.circlesRevealed)}/6 · attuned ${avg(results, r => r.attunes)} · burned in stack ${avg(results, r => r.circlesBurnedInStack)} · plan flips ${avg(results, r => r.planFlips)}`);
  console.log('loss reasons:');
  for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ summary, results }, null, 2));
    console.log('\nresults written to ' + JSON_OUT);
  }
}

if (!isMainThread) {
  // WORKER: play the assigned seed shard, stream progress, return results
  const { seedStart, count } = workerData;
  const results = []; let errors = 0, wins = 0, last = 0;
  for (let i = 0; i < count; i++) {
    try { const r = playGame(seedStart + i); results.push(r); if (r.result === 'won') wins++; }
    catch (e) { errors++; parentPort.postMessage({ t: 'err', seed: seedStart + i, msg: e.message }); }
    const now = Date.now();
    if (now - last >= 300 || i === count - 1) { last = now; parentPort.postMessage({ t: 'progress', done: i + 1, wins }); }
  }
  parentPort.postMessage({ t: 'done', results, errors });
} else if (JOBS <= 1) {
  // SINGLE THREAD
  const t0 = Date.now();
  const results = []; let errors = 0, winsSoFar = 0, lastPrint = 0;
  for (let g = 0; g < GAMES; g++) {
    try {
      const r = playGame(BASE_SEED + g); results.push(r); if (r.result === 'won') winsSoFar++;
      if (VERBOSE) console.log(`game ${g}: ${r.result} turns=${r.turns} stack=${r.stackLeft} marks=${r.goodMarks} ${r.lossReason}`);
    } catch (e) { errors++; console.error('game error (seed ' + (BASE_SEED + g) + '):', e.message); }
    if (showProgress) { const now = Date.now(); if (now - lastPrint >= 400 || g === GAMES - 1) { lastPrint = now; progressLine(g + 1, GAMES, winsSoFar, now - t0, errors); } }
  }
  if (showProgress && isTTY) process.stderr.write('\n');
  report(results, errors, Date.now() - t0);
} else {
  // PARALLEL: shard [BASE_SEED, BASE_SEED+GAMES) across N worker threads (~N× faster,
  // identical results — games are seed-deterministic and independent).
  const t0 = Date.now();
  const N = Math.min(JOBS, GAMES);
  const base = Math.floor(GAMES / N), extra = GAMES % N;
  const doneBy = new Array(N).fill(0), winsBy = new Array(N).fill(0);
  const allResults = []; let totalErrors = 0, finished = 0, lastPrint = 0, seed = BASE_SEED;
  await new Promise((resolve) => {
    for (let w = 0; w < N; w++) {
      const count = base + (w < extra ? 1 : 0);
      const idx = w;
      // pass the parent's CLI flags so each worker re-parses the same config
      // (--planner/--rollouts/--tiles/--params/etc.); the shard comes via workerData
      const worker = new Worker(new URL(import.meta.url), { workerData: { seedStart: seed, count }, argv: process.argv.slice(2) });
      seed += count;
      worker.on('message', (msg) => {
        if (msg.t === 'progress') {
          doneBy[idx] = msg.done; winsBy[idx] = msg.wins;
          if (showProgress) {
            const now = Date.now();
            if (now - lastPrint >= 400) { lastPrint = now; progressLine(doneBy.reduce((a, b) => a + b, 0), GAMES, winsBy.reduce((a, b) => a + b, 0), now - t0, totalErrors); }
          }
        } else if (msg.t === 'err') { console.error('game error (seed ' + msg.seed + '):', msg.msg); }
        else if (msg.t === 'done') { for (const r of msg.results) allResults.push(r); totalErrors += msg.errors; if (++finished === N) resolve(); }
      });
      worker.on('error', (e) => { console.error('worker crashed:', e.message); if (++finished === N) resolve(); });
    }
  });
  if (showProgress && isTTY) process.stderr.write('\n');
  report(allResults, totalErrors, Date.now() - t0);
}

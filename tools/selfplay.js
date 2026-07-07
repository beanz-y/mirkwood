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
import { writeFileSync } from 'node:fs';

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
const JSON_OUT = opt('json', null);
// balance experiments: override any tile counts, e.g. --tiles '{"rune":7}'
const TILE_OVERRIDE = opt('tiles', null) ? JSON.parse(opt('tiles', null)) : null;

// policy + shared helpers live in tools/policy.js — tune the party there
import { policy, hasGoodMark, mulberry, tileAt, tilesOf } from './policy.js';

// ---------------------------------------------------------------- runner

function playGame(seed) {
  const rnd = mulberry(seed * 7 + 3);
  const ctx = {};
  const s = createGame({
    seed,
    tiles: { ...(TILE_PRESETS[PRESET] || normTiles({})), ...(TILE_OVERRIDE || {}) },
    randomRunes: RANDOM_RUNES,
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

const t0 = Date.now();
const results = [];
let errors = 0;
for (let g = 0; g < GAMES; g++) {
  try {
    const r = playGame(BASE_SEED + g);
    results.push(r);
    if (VERBOSE) console.log(`game ${g}: ${r.result} turns=${r.turns} stack=${r.stackLeft} marks=${r.goodMarks} ${r.lossReason}`);
  } catch (e) {
    errors++;
    console.error('game error (seed ' + (BASE_SEED + g) + '):', e.message);
  }
}
const ms = Date.now() - t0;

const wins = results.filter(r => r.result === 'won');
const losses = results.filter(r => r.result === 'lost');
const avg = (arr, f) => arr.length ? (arr.reduce((n, x) => n + f(x), 0) / arr.length).toFixed(1) : '-';
const reasons = {};
for (const r of losses) {
  const short = r.lossReason.split('—')[0].split('.')[0].trim().slice(0, 60);
  reasons[short] = (reasons[short] || 0) + 1;
}

const summary = {
  policy: 'v2-cooperative',
  preset: PRESET,
  randomRunes: RANDOM_RUNES,
  games: results.length,
  errors,
  wins: wins.length,
  winRate: +(100 * wins.length / Math.max(1, results.length)).toFixed(2),
  avgTurns: +avg(results, r => r.turns),
  avgStackLeft: +avg(results, r => r.stackLeft),
  avgGoodMarks: +avg(results, r => r.goodMarks),
  lossReasons: reasons,
  msPerGame: +(ms / Math.max(1, results.length)).toFixed(2),
};

console.log('\n=== Mirkwood self-play (policy v2 — cooperative) ===');
console.log(`preset=${PRESET} randomRunes=${RANDOM_RUNES} games=${results.length} errors=${errors} (${ms}ms, ${summary.msPerGame}ms/game)`);
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

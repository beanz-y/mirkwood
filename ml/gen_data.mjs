/*
 * Mirkwood ML data generator (offline). Plays self-play games with the heuristic
 * bot (greedy / planner / +rollouts) and records every MOVEMENT decision as a
 * training sample: (features, legal-mask, chosen-move, game-outcome). This is the
 * imitation dataset — Phase 1 distils the bot's movement policy into a fast net.
 *
 *   node ml/gen_data.mjs --games 5000 --planner --out ml/data/imit
 *   node ml/gen_data.mjs --games 2000 --planner --rollouts 4 --tiles cross:40,rune:10,draugr:0 --out ml/data/win
 *
 * Writes three files sharing the --out prefix:
 *   <out>.x.f32   float32  [N, FEATURE_LEN]   features
 *   <out>.y.u8    uint8    [N, 8]             legal[5], chosen, value(win), seat
 *   <out>.meta.json                            { n, featureLen, moveActions, ... }
 */
import { createGame, applyAction, TILE_PRESETS, normTiles } from '../public/shared/engine.js';
import { policy, mulberry, computePlan } from '../tools/policy.js';
import { encodeState, encodeStatePlan, moveLegal, moveChosenIndex, FEATURE_LEN, FEATURE_LEN_PLAN, MOVE_ACTIONS } from './encode.mjs';
import { createWriteStream, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
function parseTiles(str) {
  if (!str) return null;
  str = str.trim();
  try { return JSON.parse(str); } catch { /* lenient */ }
  const out = {};
  for (const pair of str.replace(/^\{|\}$/g, '').split(',')) {
    if (!pair.trim()) continue;
    const [k, v] = pair.split(/[:=]/);
    const key = (k || '').trim().replace(/['"]/g, ''); const val = Number((v || '').trim());
    if (key && Number.isFinite(val)) out[key] = val;
  }
  return Object.keys(out).length ? out : null;
}

const GAMES = +opt('games', 2000);
const BASE_SEED = +opt('seed', 1000);
const PRESET = opt('preset', 'normal');
const RANDOM_RUNES = flag('randomRunes');
const ROLLOUTS = +opt('rollouts', 0);
const USE_PLANNER = flag('planner');
const USE_PLAN = flag('plan'); // append the planner's assignment to the features (plan-conditioned)
const TILES = parseTiles(opt('tiles', null));
const OUT = opt('out', 'ml/data/imit');
mkdirSync(dirname(OUT), { recursive: true });

const xs = createWriteStream(OUT + '.x.f32');
const ys = createWriteStream(OUT + '.y.u8');
let N = 0, wins = 0;
const t0 = Date.now();

for (let g = 0; g < GAMES; g++) {
  const seed = BASE_SEED + g;
  const rnd = mulberry(seed * 7 + 3);
  const ctx = { rollouts: ROLLOUTS };
  if (USE_PLANNER) ctx.usePlanner = true;
  const s = createGame({ seed, tiles: { ...(TILE_PRESETS[PRESET] || normTiles({})), ...(TILES || {}) }, randomRunes: RANDOM_RUNES });
  const recs = [];
  let steps = 0, empty = 0;
  while (s.phase !== 'won' && s.phase !== 'lost') {
    empty = s.stack.length === 0 ? empty + 1 : 0;
    if (++steps > 6000 || empty > 600) { s.phase = 'lost'; break; }
    const aw = s.awaiting;
    const action = policy(s, rnd, ctx);
    if (aw.type === 'action') {
      const chosen = moveChosenIndex(action);
      if (chosen >= 0) {
        const f = USE_PLAN ? encodeStatePlan(s, aw.seat, computePlan(s, ctx)) : encodeState(s, aw.seat);
        recs.push({ f, legal: moveLegal(aw), chosen, seat: aw.seat });
      }
    }
    applyAction(s, aw.seat, action);
  }
  const win = s.phase === 'won' ? 1 : 0; wins += win;
  for (const r of recs) {
    xs.write(Buffer.from(r.f.buffer, r.f.byteOffset, r.f.byteLength));
    ys.write(Buffer.from(Uint8Array.from([...r.legal, r.chosen, win, r.seat])));
    N++;
  }
}

xs.end(); ys.end();
writeFileSync(OUT + '.meta.json', JSON.stringify({
  n: N, featureLen: USE_PLAN ? FEATURE_LEN_PLAN : FEATURE_LEN, planConditioned: USE_PLAN, moveActions: MOVE_ACTIONS,
  labelLayout: ['legalN', 'legalE', 'legalS', 'legalW', 'legalStay', 'chosen', 'value', 'seat'],
  games: GAMES, preset: PRESET, tiles: TILES, planner: USE_PLANNER, rollouts: ROLLOUTS,
  botWinRate: +(100 * wins / GAMES).toFixed(2),
}, null, 2));
console.log(`wrote ${N} movement samples from ${GAMES} games (bot win ${(100 * wins / GAMES).toFixed(2)}%) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  ${OUT}.x.f32  (${(N * FEATURE_LEN * 4 / 1e6).toFixed(1)} MB)   ${OUT}.y.u8   ${OUT}.meta.json`);

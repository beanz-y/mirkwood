/*
 * Mirkwood ML — DAgger data generator. The NET drives movement (so we collect
 * the states the net actually visits — its own distribution), but every state is
 * LABELLED with what the heuristic bot (planner) would do there. Aggregating these
 * bot-corrections with the base data and retraining makes the net robust on its
 * OWN trajectories — the fix for the compounding-error collapse of plain imitation.
 *
 *   node ml/dagger_gen.mjs --games 1000 --model ml/model.onnx --tiles cross:40,rune:10,draugr:0 --out ml/data/dag1
 */
import * as ort from 'onnxruntime-node';
import { createGame, applyAction, TILE_PRESETS, normTiles } from '../public/shared/engine.js';
import { policy, mulberry, computePlan } from '../tools/policy.js';
import { encodeState, encodeStatePlan, moveLegal, moveChosenIndex, FEATURE_LEN, FEATURE_LEN_PLAN, MOVE_ACTIONS } from './encode.mjs';
import { createWriteStream, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
function parseTiles(str) {
  if (!str) return null; str = str.trim();
  try { return JSON.parse(str); } catch { /* lenient */ }
  const out = {};
  for (const pair of str.replace(/^\{|\}$/g, '').split(',')) {
    if (!pair.trim()) continue; const [k, v] = pair.split(/[:=]/);
    const key = (k || '').trim().replace(/['"]/g, ''); const val = Number((v || '').trim());
    if (key && Number.isFinite(val)) out[key] = val;
  }
  return Object.keys(out).length ? out : null;
}
const GAMES = +opt('games', 1000);
const BASE_SEED = +opt('seed', 500000);
const PRESET = opt('preset', 'normal');
const TILES = parseTiles(opt('tiles', null));
const MODEL = opt('model', 'ml/model.onnx');
const OUT = opt('out', 'ml/data/dag');
const USE_PLAN = flag('plan');
const EPS = +opt('eps', 0.05); // small exploration so the net visits varied states
mkdirSync(dirname(OUT), { recursive: true });

const session = await ort.InferenceSession.create(MODEL);
const xs = createWriteStream(OUT + '.x.f32');
const ys = createWriteStream(OUT + '.y.u8');
let N = 0, wins = 0, agree = 0;
const t0 = Date.now();

async function netPick(f, legal, rnd) {
  const out = await session.run({ features: new ort.Tensor('float32', f, [1, f.length]) });
  const lg = out.policy.data;
  if (rnd() < EPS) { // epsilon exploration to widen the visited distribution
    const legals = []; for (let i = 0; i < 5; i++) if (legal[i]) legals.push(i);
    return legals[Math.floor(rnd() * legals.length)];
  }
  let best = -1, bv = -Infinity;
  for (let i = 0; i < 5; i++) if (legal[i] && lg[i] > bv) { bv = lg[i]; best = i; }
  return best;
}

for (let g = 0; g < GAMES; g++) {
  const seed = BASE_SEED + g;
  const rnd = mulberry(seed * 7 + 3);
  const ctx = { usePlanner: true };
  const s = createGame({ seed, tiles: { ...(TILE_PRESETS[PRESET] || normTiles({})), ...(TILES || {}) } });
  const recs = [];
  let steps = 0, empty = 0;
  while (s.phase !== 'won' && s.phase !== 'lost') {
    empty = s.stack.length === 0 ? empty + 1 : 0;
    if (++steps > 6000 || empty > 600) { s.phase = 'lost'; break; }
    const aw = s.awaiting;
    if (aw.type === 'action') {
      const f = USE_PLAN ? encodeStatePlan(s, aw.seat, computePlan(s, ctx)) : encodeState(s, aw.seat);
      const legal = moveLegal(aw);
      const botIdx = moveChosenIndex(policy(s, rnd, ctx)); // the LABEL (what the bot would do)
      const netIdx = await netPick(f, legal, rnd);         // what the net does (executed)
      if (botIdx >= 0) { recs.push({ f, legal, chosen: botIdx, seat: aw.seat }); if (botIdx === netIdx) agree++; }
      const idx = netIdx >= 0 ? netIdx : (aw.stay ? 4 : aw.moves[0].d);
      applyAction(s, aw.seat, idx === 4 ? { kind: 'stay' } : { kind: 'move', d: idx });
    } else {
      applyAction(s, aw.seat, policy(s, rnd, ctx)); // heuristic for non-movement decisions
    }
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
  dagger: true, model: MODEL, games: GAMES, tiles: TILES,
  netWinRate: +(100 * wins / GAMES).toFixed(2), netVsBotAgree: +(100 * agree / N).toFixed(1),
}, null, 2));
console.log(`DAgger: ${N} bot-labelled samples from ${GAMES} net-driven games (net win ${(100 * wins / GAMES).toFixed(2)}%, net~bot agree ${(100 * agree / N).toFixed(1)}%) in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${OUT}`);

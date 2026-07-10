/*
 * Mirkwood ML — Phase 1 validation. Plays self-play where the NET decides every
 * movement (a single ONNX forward pass) and the heuristic handles everything else
 * (attune / placement / niflheim). Reports win rate — the test of whether the net
 * successfully distilled the bot's movement policy.
 *
 *   node ml/play_net.mjs --games 2000 --tiles cross:40,rune:10,draugr:0
 *   node ml/play_net.mjs --games 20000 --model ml/model.onnx
 */
import * as ort from 'onnxruntime-node';
import { createGame, applyAction, TILE_PRESETS, normTiles } from '../public/shared/engine.js';
import { policy, mulberry, computePlan } from '../tools/policy.js';
import { encodeState, encodeStatePlan, moveLegal } from './encode.mjs';

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
const GAMES = +opt('games', 2000);
const BASE_SEED = +opt('seed', 1000);
const PRESET = opt('preset', 'normal');
const TILES = parseTiles(opt('tiles', null));
const MODEL = opt('model', 'ml/model.onnx');
const SAMPLE = flag('sample'); // sample from the policy instead of argmax
const USE_PLAN = flag('plan'); // plan-conditioned net (feed the planner's assignment)

const session = await ort.InferenceSession.create(MODEL);

async function netMove(s, aw, ctx) {
  const f = USE_PLAN ? encodeStatePlan(s, aw.seat, computePlan(s, ctx)) : encodeState(s, aw.seat);
  const out = await session.run({ features: new ort.Tensor('float32', f, [1, f.length]) });
  const logits = out.policy.data;
  const legal = moveLegal(aw);
  if (SAMPLE) {
    let z = 0; const p = [0, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) if (legal[i]) { p[i] = Math.exp(logits[i]); z += p[i]; }
    let r = Math.random() * z, pick = -1;
    for (let i = 0; i < 5; i++) if (legal[i]) { r -= p[i]; if (r <= 0) { pick = i; break; } }
    if (pick >= 0) return pick === 4 ? { kind: 'stay' } : { kind: 'move', d: pick };
  }
  let best = -1, bestv = -Infinity;
  for (let i = 0; i < 5; i++) if (legal[i] && logits[i] > bestv) { bestv = logits[i]; best = i; }
  if (best < 0) return aw.stay ? { kind: 'stay' } : { kind: 'move', d: aw.moves[0].d };
  return best === 4 ? { kind: 'stay' } : { kind: 'move', d: best };
}

async function playGame(seed) {
  const rnd = mulberry(seed * 7 + 3);
  const ctx = { usePlanner: true }; // heuristic for non-movement decisions (matches data-gen)
  const s = createGame({ seed, tiles: { ...(TILE_PRESETS[PRESET] || normTiles({})), ...(TILES || {}) } });
  let steps = 0, empty = 0;
  while (s.phase !== 'won' && s.phase !== 'lost') {
    empty = s.stack.length === 0 ? empty + 1 : 0;
    if (++steps > 6000 || empty > 600) { s.phase = 'lost'; break; }
    const aw = s.awaiting;
    const action = aw.type === 'action' ? await netMove(s, aw, ctx) : policy(s, rnd, ctx);
    applyAction(s, aw.seat, action);
  }
  return s.phase === 'won';
}

const t0 = Date.now();
let wins = 0;
for (let g = 0; g < GAMES; g++) if (await playGame(BASE_SEED + g)) wins++;
const ms = Date.now() - t0;
console.log(`NET movement + heuristic: ${wins}/${GAMES} = ${(100 * wins / GAMES).toFixed(2)}%  (${(ms / GAMES).toFixed(1)}ms/game, model=${MODEL})`);

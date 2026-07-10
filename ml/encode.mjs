/*
 * Mirkwood ML feature encoder (offline). Turns a live engine state + deciding
 * soul into a flat Float32 vector for a small MLP, and defines the movement
 * action space the net predicts. Imports the REAL engine.js — the features are
 * exactly what the deployed game exposes, so an ONNX net trained on them runs
 * unchanged in the browser/Worker later.
 */
import { SIZE, key, litSet, RUNES, stepDir } from '../public/shared/engine.js';

// movement action space the policy head predicts: a DIRECTION or Stay. The engine
// resolves the kind (move / blind / jump / charge) from the board, so the net
// only ever chooses among these five.
export const MOVE_ACTIONS = ['N', 'E', 'S', 'W', 'stay']; // dirs 0..3 then stay

// per-cell feature block (keep in sync with the count below)
const PER_CELL = 20;
export const FEATURE_LEN = SIZE * SIZE * PER_CELL + 38;

const gates = ['valhalla', 'folkvangr'];

export function encodeState(s, seat) {
  const F = new Float32Array(FEATURE_LEN);
  let i = 0;
  const lit = litSet(s);
  // ---- board: 36 cells, cell-major ----
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const cl = s.grid[key(r, c)];
    const t = cl && cl.tile;
    F[i++] = t ? 1 : 0;
    for (let d = 0; d < 4; d++) F[i++] = (t && t.exits[d]) ? 1 : 0;
    F[i++] = (t && t.kind === 'straight') ? 1 : 0;
    F[i++] = (t && t.kind === 'tee') ? 1 : 0;
    F[i++] = (t && t.kind === 'cross') ? 1 : 0;
    F[i++] = (t && t.kind === 'rune') ? 1 : 0;
    F[i++] = (t && t.kind === 'draugr') ? 1 : 0;
    F[i++] = (t && t.kind === 'gate' && t.gate === 'valhalla') ? 1 : 0;
    F[i++] = (t && t.kind === 'gate' && t.gate === 'folkvangr') ? 1 : 0;
    F[i++] = (t && t.kind === 'start') ? 1 : 0;
    F[i++] = (t && t.fractured) ? 1 : 0;
    F[i++] = (t && t.kind === 'rune' && t.spent) ? 1 : 0;
    F[i++] = (cl && cl.rift) ? 1 : 0;
    F[i++] = lit.has(key(r, c)) ? 1 : 0;
    let me = 0, other = 0, hopeful = 0;
    for (const q of s.players) {
      if (!q.placed || q.r !== r || q.c !== c) continue;
      if (q.seat === seat) me = 1; else other = 1;
      if (q.hopeful) hopeful = 1;
    }
    F[i++] = me; F[i++] = other; F[i++] = hopeful;
  }
  // ---- globals ----
  const stack = s.stack;
  const cnt = k => stack.reduce((n, t) => n + (t.kind === k ? 1 : 0), 0);
  const gcnt = g => stack.reduce((n, t) => n + (t.kind === 'gate' && t.gate === g ? 1 : 0), 0);
  F[i++] = cnt('straight') / 74; F[i++] = cnt('tee') / 74; F[i++] = cnt('cross') / 74;
  F[i++] = cnt('rune') / 74; F[i++] = cnt('draugr') / 74;
  F[i++] = gcnt('valhalla'); F[i++] = gcnt('folkvangr');
  F[i++] = stack.length / 74;
  F[i++] = s.niflheim ? 1 : 0;
  const aw = s.awaiting;
  F[i++] = aw && aw.stay ? 1 : 0;
  F[i++] = aw && aw.rekindle ? 1 : 0;
  for (let k = 0; k < 4; k++) F[i++] = (k === seat) ? 1 : 0; // deciding seat one-hot
  for (let k = 0; k < 4; k++) {
    const q = s.players[k];
    F[i++] = q.placed ? 1 : 0;
    F[i++] = q.hopeful ? 1 : 0;
    F[i++] = (q.resolve || 0) / 2;
    F[i++] = q.rune && q.rune.p === 'valhalla' ? 1 : 0;
    F[i++] = q.rune && q.rune.p === 'folkvangr' ? 1 : 0;
  }
  for (const g of gates) {
    const marks = new Set(s.players.filter(q => q.rune && q.rune.p === g).map(q => q.rune.k)).size;
    F[i++] = marks / 4;
  }
  let circles = stack.filter(t => t.kind === 'rune').length;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const t = s.grid[key(r, c)] && s.grid[key(r, c)].tile;
    if (t && t.kind === 'rune' && !t.spent) circles++;
  }
  F[i++] = circles / 6;
  return F;
}

// ---- PLAN-CONDITIONED features (append the planner's cheap assignment so the
// net doesn't have to INFER the plan — the fix for the distillation failure).
const GOALS = ['rune', 'gate', 'guard', 'fish'];
const wrapD = (r1, c1, r2, c2) =>
  Math.min(Math.abs(r1 - r2), SIZE - Math.abs(r1 - r2)) + Math.min(Math.abs(c1 - c2), SIZE - Math.abs(c1 - c2));
export const PLAN_EXTRA = GOALS.length + SIZE * SIZE + 4 + SIZE * SIZE; // goal one-hot + my-target plane + toward-dir + all-targets plane
export const FEATURE_LEN_PLAN = FEATURE_LEN + PLAN_EXTRA;

// base features + the deciding soul's assigned goal/target (and all souls' targets)
export function encodeStatePlan(s, seat, P2) {
  const base = encodeState(s, seat);
  const ex = [];
  const a = (P2.assign && P2.assign[seat]) || { goal: 'fish', target: null };
  for (const g of GOALS) ex.push(a.goal === g ? 1 : 0);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++)
    ex.push(a.target && a.target[0] === r && a.target[1] === c ? 1 : 0); // my target
  const p = s.players[seat];
  for (let d = 0; d < 4; d++) {
    if (!a.target) { ex.push(0); continue; }
    const [nr, nc] = stepDir(p.r, p.c, d);
    ex.push(wrapD(nr, nc, a.target[0], a.target[1]) < wrapD(p.r, p.c, a.target[0], a.target[1]) ? 1 : 0);
  }
  const tset = new Set();
  for (const st in P2.assign) { const t = P2.assign[st].target; if (t) tset.add(key(t[0], t[1])); }
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) ex.push(tset.has(key(r, c)) ? 1 : 0); // all targets
  const out = new Float32Array(base.length + ex.length);
  out.set(base, 0); out.set(Float32Array.from(ex), base.length);
  return out;
}

// legal mask over MOVE_ACTIONS for an `action` decision
export function moveLegal(aw) {
  const mask = [0, 0, 0, 0, 0];
  for (const m of aw.moves) if (m.kind !== 'charge') mask[m.d] = 1; // net never charges (heuristic-only)
  if (aw.stay) mask[4] = 1;
  return mask;
}

// index in MOVE_ACTIONS of the action the bot actually chose (or -1 to skip)
export function moveChosenIndex(action) {
  if (action.kind === 'stay') return 4;
  if (action.kind === 'move') return action.d;
  return -1; // rekindle/charge etc. — not a movement target; skip this sample
}

/*
 * Mirkwood — authoritative game engine.
 * Pure logic, no I/O. Shared by the Node server and (for constants/helpers)
 * the browser client.
 *
 * Board: 6x6, edges wrap (the forest loops).
 * Directions: 0=N 1=E 2=S 3=W.
 */

export const SIZE = 6;
export const DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]];
export const DIRNAMES = ['north', 'east', 'south', 'west'];
export const OPP = d => (d + 2) % 4;

export const RUNES = {
  valhalla: [
    { k: 'thurisaz', g: 'ᚦ', name: 'Thurisaz', gloss: 'Thorn — strength and defense' },
    { k: 'eihwaz',   g: 'ᛇ', name: 'Eihwaz',   gloss: 'Yew — endurance beyond death' },
    { k: 'isa',      g: 'ᛁ', name: 'Isa',      gloss: 'Ice — willpower and sacrifice' },
    { k: 'raido',    g: 'ᚱ', name: 'Raido',    gloss: 'Ride — the righteous path' },
  ],
  folkvangr: [
    { k: 'berkano', g: 'ᛒ', name: 'Berkano', gloss: 'Birch — nurture and protection' },
    { k: 'uruz',    g: 'ᚢ', name: 'Uruz',    gloss: 'Aurochs — vitality and growth' },
    { k: 'ansuz',   g: 'ᚨ', name: 'Ansuz',   gloss: 'God — wisdom and inspiration' },
    { k: 'wunjo',   g: 'ᚹ', name: 'Wunjo',   gloss: 'Joy — harmony and fulfilment' },
  ],
};
export const GATE_NAMES = { valhalla: 'Valhalla', folkvangr: 'Fólkvangr' };
export const PLAYER_COLORS = ['#e8b23c', '#d05e5e', '#4fb8a8', '#a678d8'];
export const DEFAULT_NAMES = ['Astrid', 'Bjorn', 'Eira', 'Torvald'];

// Base exits (before rotation), N,E,S,W
const BASE_EXITS = {
  start:    [1, 1, 0, 0],
  straight: [1, 0, 1, 0],
  tee:      [1, 1, 0, 1],
  cross:    [1, 1, 1, 1],
  rune:     [1, 1, 1, 1],
  gate:     [1, 0, 0, 0],
  draugr:   [1, 1, 1, 1],
};

export function exitsFor(kind, rot) {
  const base = BASE_EXITS[kind];
  const out = [0, 0, 0, 0];
  for (let d = 0; d < 4; d++) out[d] = base[(d - rot + 4) % 4];
  return out;
}

export const wrap = x => ((x % SIZE) + SIZE) % SIZE;
export const key = (r, c) => r * SIZE + c;
export const stepDir = (r, c, d) => [wrap(r + DIRS[d][0]), wrap(c + DIRS[d][1])];

// ---------------------------------------------------------------- RNG

function rand(s) {
  // mulberry32
  s.rngState |= 0;
  s.rngState = (s.rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(s.rngState ^ (s.rngState >>> 15), 1 | s.rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle(s, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand(s) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------- tiles

function makeTileDef(s, kind, opts = {}) {
  return {
    id: 't' + (++s.tileSeq),
    kind,
    fractured: !!opts.fractured,
    gate: opts.gate || null,
  };
}

function buildStack(s) {
  const pool = [];
  for (let i = 0; i < 10; i++) pool.push(makeTileDef(s, 'straight', { fractured: true }));
  for (let i = 0; i < 30; i++) pool.push(makeTileDef(s, 'tee'));
  for (let i = 0; i < 2; i++) pool.push(makeTileDef(s, 'tee', { fractured: true }));
  for (let i = 0; i < 12; i++) pool.push(makeTileDef(s, 'cross'));
  for (let i = 0; i < 6; i++) pool.push(makeTileDef(s, 'rune', { fractured: true }));
  for (let i = 0; i < 12; i++) pool.push(makeTileDef(s, 'draugr'));
  pool.push(makeTileDef(s, 'gate', { gate: 'valhalla' }));
  pool.push(makeTileDef(s, 'gate', { gate: 'folkvangr' }));

  // Opening tiles: 2 straight, 4 plain T, 2 cross go on top so the first
  // reveals of the game are always simple paths (TNC parity).
  const opening = [];
  const take = (pred, n) => {
    for (let i = pool.length - 1; i >= 0 && n > 0; i--) {
      if (pred(pool[i])) { opening.push(pool.splice(i, 1)[0]); n--; }
    }
  };
  take(t => t.kind === 'straight', 2);
  take(t => t.kind === 'tee' && !t.fractured, 4);
  take(t => t.kind === 'cross', 2);

  shuffle(s, pool);
  shuffle(s, opening);
  // stack draws with pop(): last element = next draw, so opening goes last.
  return pool.concat(opening);
}

// ---------------------------------------------------------------- state

export function createGame(opts = {}) {
  const s = {
    phase: 'setup', // setup | play | won | lost
    grid: Array(SIZE * SIZE).fill(null), // null | {tile:{id,kind,fractured,gate,rot,exits}} | {rift:true}
    stack: [],
    discard: [], // public: tiles lost, in order
    players: [],
    turn: 0,
    queue: [],
    awaiting: null,
    niflheim: false,
    winnerGate: null,
    lossReason: null,
    log: [],
    events: [], // ordered semantic events of the current action, for client animation
    rngState: (opts.seed ?? Math.floor(Math.random() * 2 ** 31)) | 0,
    tileSeq: 0,
    moveCtx: null,
    pendingHit: null,
    blindCtx: null,
    movesThisTurn: 0,
  };
  const names = opts.names || DEFAULT_NAMES;
  for (let i = 0; i < 4; i++) {
    s.players.push({
      seat: i,
      name: names[i] || DEFAULT_NAMES[i],
      color: PLAYER_COLORS[i],
      r: null, c: null,
      placed: false,
      hopeful: true,
      resolve: 1,
      rune: null,      // {p:'valhalla'|'folkvangr', k}
      falling: null,   // {r,c} rift fallen through
    });
  }
  s.stack = opts.stack ? opts.stack.map(t => makeTileDef(s, t.kind, t)) : buildStack(s);
  log(s, 'The souls awaken beneath the boughs of Myrkviðr.', 'turn');
  s.queue.push({ t: 'setup', seat: 0 });
  run(s);
  return s;
}

function log(s, m, k = 'info') {
  s.log.push({ m, k });
  if (s.log.length > 250) s.log.splice(0, s.log.length - 250);
}

// semantic events in resolution order, consumed by the client's animation
// timeline; cleared at the start of every applyAction
function ev(s, e, data) {
  s.events.push({ e, ...data });
  if (s.events.length > 80) s.events.splice(0, s.events.length - 80);
}

const P = (s, seat) => s.players[seat];
const cellAt = (s, r, c) => s.grid[key(r, c)];
const tileAt = (s, r, c) => { const cl = s.grid[key(r, c)]; return cl && cl.tile ? cl.tile : null; };
const riftAt = (s, r, c) => { const cl = s.grid[key(r, c)]; return !!(cl && cl.rift); };
const occupantsAt = (s, r, c) => s.players.filter(p => p.placed && p.r === r && p.c === c);

function setTile(s, r, c, def, rot) {
  s.grid[key(r, c)] = { tile: { ...def, rot, exits: exitsFor(def.kind, rot) } };
}

function err(msg) { const e = new Error(msg); e.illegal = true; throw e; }

// ---------------------------------------------------------------- light

export function litSet(s) {
  const lit = new Set();
  for (const p of s.players) {
    if (!p.placed) continue;
    lit.add(key(p.r, p.c));
    if (!p.hopeful) continue;
    const t = tileAt(s, p.r, p.c);
    if (!t) continue;
    for (let d = 0; d < 4; d++) {
      if (t.exits[d]) {
        const [nr, nc] = stepDir(p.r, p.c, d);
        lit.add(key(nr, nc));
      }
    }
  }
  return lit;
}

function describeTile(t) {
  if (t.kind === 'gate') return `the Gate of ${GATE_NAMES[t.gate]}`;
  if (t.kind === 'rune') return 'a Rune Circle';
  if (t.kind === 'draugr') return 'a Draugr';
  return 'a path';
}

function sweep(s) {
  const lit = litSet(s);
  const lost = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const cl = cellAt(s, r, c);
    if (!cl || lit.has(key(r, c))) continue;
    if (cl.tile) {
      if (cl.tile.kind === 'gate') continue; // gates are permanent
      s.discard.push(cl.tile);
      if (cl.tile.kind === 'rune') log(s, 'A Rune Circle is swallowed by the mist.', 'danger');
      else if (cl.tile.kind === 'draugr') log(s, 'A Draugr fades back into the mist.', 'good');
    }
    lost.push({ r, c, tile: cl.tile || null, rift: !!cl.rift });
    s.grid[key(r, c)] = null; // rifts close silently when unlit
  }
  if (lost.length) ev(s, 'sweep', { cells: lost });
}

// ---------------------------------------------------------------- draugr sight

export function losFor(s, mr, mc) {
  // Line of sight of a monster at (mr,mc): its own cell plus every cell along
  // unbroken connected corridors in the 4 directions (wrapping). Rifts, empty
  // spaces and walls break the line.
  const out = new Set([key(mr, mc)]);
  for (let d = 0; d < 4; d++) {
    let r = mr, c = mc;
    for (let i = 0; i < SIZE - 1; i++) {
      const here = tileAt(s, r, c);
      if (!here || !here.exits[d]) break;
      const [nr, nc] = stepDir(r, c, d);
      if (nr === mr && nc === mc) break; // full wrap guard
      const next = tileAt(s, nr, nc);
      if (!next || !next.exits[OPP(d)]) break;
      out.add(key(nr, nc));
      r = nr; c = nc;
    }
  }
  return out;
}

function allDraugr(s) {
  const out = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const t = tileAt(s, r, c);
    if (t && t.kind === 'draugr') out.push([r, c]);
  }
  return out;
}

function triggeredBy(s, cells) {
  // monsters whose LoS intersects any of `cells` (keys), on the CURRENT board
  const trig = [];
  for (const [r, c] of allDraugr(s)) {
    const los = losFor(s, r, c);
    if (cells.some(k => los.has(k))) trig.push([r, c]);
  }
  return trig;
}

function expandChains(s, trig) {
  // A triggered draugr whose sight reaches another draugr triggers it too.
  const seen = new Set(trig.map(([r, c]) => key(r, c)));
  const queue = [...trig];
  while (queue.length) {
    const [r, c] = queue.shift();
    const los = losFor(s, r, c);
    for (const [dr, dc] of allDraugr(s)) {
      const k = key(dr, dc);
      if (!seen.has(k) && los.has(k)) { seen.add(k); queue.push([dr, dc]); }
    }
  }
  return [...seen].map(k => [Math.floor(k / SIZE), k % SIZE]);
}

function raysFor(s, mr, mc) {
  // ordered corridor cells per direction — the shape of the monster's strike
  const rays = [];
  for (let d = 0; d < 4; d++) {
    const ray = [];
    let r = mr, c = mc;
    for (let i = 0; i < SIZE - 1; i++) {
      const here = tileAt(s, r, c);
      if (!here || !here.exits[d]) break;
      const [nr, nc] = stepDir(r, c, d);
      if (nr === mr && nc === mc) break;
      const next = tileAt(s, nr, nc);
      if (!next || !next.exits[OPP(d)]) break;
      ray.push([nr, nc]);
      r = nr; c = nc;
    }
    if (ray.length) rays.push(ray);
  }
  return rays;
}

function startHitWave(s, trig, ctx) {
  // ctx: {mover, lateral} — mover may earn Resolve for evading (lateral moves only)
  s.moveCtx = { mover: ctx.mover, lateral: !!ctx.lateral, triggered: trig.length, moverHit: false };
  if (trig.length === 0) { s.queue.unshift({ t: 'after-hits' }); return; }
  const monsters = expandChains(s, trig);
  const hits = [];
  for (const [mr, mc] of monsters) {
    const rays = raysFor(s, mr, mc);
    const los = losFor(s, mr, mc);
    const victims = [];
    for (const p of s.players) {
      if (!p.placed) continue;
      if (los.has(key(p.r, p.c))) {
        victims.push(p.seat);
        hits.push({ t: 'hit', seat: p.seat, m: [mr, mc] });
      }
    }
    ev(s, 'attack', { m: [mr, mc], rays, victims });
  }
  log(s, monsters.length > 1
    ? `${monsters.length} Draugr shriek in a chain of spite!`
    : 'A Draugr shrieks and strikes!', 'danger');
  s.queue.unshift(...hits, { t: 'after-hits' });
}

function discardN(s, n) {
  let burned = 0;
  for (let i = 0; i < n && s.stack.length; i++) {
    const t = s.stack.pop();
    s.discard.push(t);
    burned++;
    if (t.kind === 'gate') log(s, `The Gate of ${GATE_NAMES[t.gate]} is lost to the mist!`, 'danger');
    else if (t.kind === 'rune') log(s, 'A Rune Circle is lost from the path stack.', 'danger');
  }
  if (burned) ev(s, 'burn', { n: burned });
}

function drawTile(s) { return s.stack.pop() || null; }

// ---------------------------------------------------------------- fracture / fall

function fractureCell(s, r, c) {
  const t = tileAt(s, r, c);
  if (!t) return;
  s.discard.push(t);
  if (t.kind === 'rune') log(s, 'The Rune Circle crumbles into a Void Rift!', 'danger');
  else log(s, 'The fractured path crumbles into a Void Rift.', 'info');
  ev(s, 'fracture', { r, c, tile: t });
  s.grid[key(r, c)] = { rift: true };
}

// ---------------------------------------------------------------- options

export function computeMoves(s, p) {
  const moves = [];
  if (!p.placed) return moves;
  const t = tileAt(s, p.r, p.c);
  if (!t) return moves;
  for (let d = 0; d < 4; d++) {
    if (!t.exits[d]) continue;
    const [nr, nc] = stepDir(p.r, p.c, d);
    const cl = cellAt(s, nr, nc);
    if (cl && cl.rift) { moves.push({ d, kind: 'jump', r: nr, c: nc }); continue; }
    const nt = cl && cl.tile;
    if (nt) {
      if (!nt.exits[OPP(d)]) continue; // wall
      if (nt.kind === 'draugr') {
        if (p.resolve > 0) moves.push({ d, kind: 'charge', r: nr, c: nc });
        continue;
      }
      if (nt.kind !== 'gate' && occupantsAt(s, nr, nc).length) continue;
      moves.push({ d, kind: 'move', r: nr, c: nc });
    } else if (!p.hopeful && s.stack.length > 0) {
      moves.push({ d, kind: 'blind', r: nr, c: nc });
    }
  }
  return moves;
}

function actionOptions(s, p) {
  const moves = computeMoves(s, p);
  const stay = p.hopeful || p.resolve > 0 || moves.length === 0;
  const rekindle = !p.hopeful && p.resolve > 0;
  return { moves, stay, rekindle };
}

// ---------------------------------------------------------------- win / loss

function runesValidFor(s, pantheon) {
  const ks = new Set();
  for (const p of s.players) {
    if (!p.rune || p.rune.p !== pantheon) return false;
    ks.add(p.rune.k);
  }
  return ks.size === 4;
}

function winCheck(s) {
  if (s.phase !== 'play') return;
  const p0 = s.players[0];
  if (!p0.placed) return;
  if (!s.players.every(p => p.placed && p.r === p0.r && p.c === p0.c)) return;
  const t = tileAt(s, p0.r, p0.c);
  if (!t || t.kind !== 'gate') return;
  if (!runesValidFor(s, t.gate)) return;
  s.phase = 'won';
  s.winnerGate = t.gate;
  s.awaiting = null;
  log(s, `The runes blaze! The Gate of ${GATE_NAMES[t.gate]} swings open. The souls are free.`, 'good');
}

function gatesLeft(s) {
  const out = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const t = tileAt(s, r, c);
    if (t && t.kind === 'gate') out.push(t.gate);
  }
  for (const t of s.stack) if (t.kind === 'gate') out.push(t.gate);
  return out;
}

function runeCirclesLeft(s) {
  let n = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const t = tileAt(s, r, c);
    if (t && t.kind === 'rune') n++;
  }
  for (const t of s.stack) if (t.kind === 'rune') n++;
  return n;
}

function lose(s, reason) {
  if (s.phase === 'won' || s.phase === 'lost') return;
  s.phase = 'lost';
  s.lossReason = reason;
  s.awaiting = null;
  s.queue = [];
  log(s, reason, 'danger');
}

function lossCheck(s) {
  if (s.phase !== 'play') return;
  const gates = gatesLeft(s);
  if (gates.length === 0) {
    lose(s, 'Both gates are lost. Niflheim claims the souls forever.');
    return;
  }
  if (runeCirclesLeft(s) === 0) {
    const possible = [...new Set(gates)].some(g => runesValidFor(s, g));
    if (!possible) lose(s, 'The last Rune Circle is gone, and the marks the souls bear cannot open a gate.');
  }
}

// ---------------------------------------------------------------- steps

const STEPS = {};

function run(s) {
  let guard = 0;
  while (!s.awaiting && s.queue.length && s.phase !== 'won' && s.phase !== 'lost') {
    if (++guard > 500) throw new Error('engine runaway');
    const step = s.queue.shift();
    STEPS[step.t](s, step);
  }
}

STEPS['setup'] = (s, { seat }) => {
  if (seat >= 4) {
    s.phase = 'play';
    s.turn = 0;
    log(s, 'The paths are lit. The search begins.', 'turn');
    s.queue.unshift({ t: 'begin-turn' });
    return;
  }
  s.awaiting = { type: 'place-start', seat };
};

STEPS['illum'] = (s, { forSeat, chooser }) => {
  const p = P(s, forSeat);
  if (!p.placed || !p.hopeful) return;
  const t = tileAt(s, p.r, p.c);
  if (!t) return;
  const targets = [];
  for (let d = 0; d < 4; d++) {
    if (!t.exits[d]) continue;
    const [nr, nc] = stepDir(p.r, p.c, d);
    if (!cellAt(s, nr, nc)) targets.push({ r: nr, c: nc, d });
  }
  if (!targets.length) return;
  if (!s.stack.length) { return; } // no light left to reveal new paths
  const tile = drawTile(s);
  const withRots = targets.map(tg => ({
    r: tg.r, c: tg.c,
    rots: [0, 1, 2, 3].filter(rot => exitsFor(tile.kind, rot)[OPP(tg.d)]),
  }));
  s.awaiting = { type: 'place-tile', seat: chooser, forSeat, tile, targets: withRots };
};

STEPS['begin-turn'] = (s) => {
  const p = P(s, s.turn);
  s.moveCtx = null;
  s.movesThisTurn = 0;
  log(s, `— ${p.name}'s turn —`, 'turn');
  if (p.falling) { STEPS['landing'](s); return; }
  s.queue.unshift({ t: 'action' });
};

STEPS['landing'] = (s) => {
  const p = P(s, s.turn);
  const { r: fr, c: fc } = p.falling;
  const lit = litSet(s);
  const cells = [];
  for (let i = 0; i < SIZE; i++) {
    cells.push([fr, i]);
    if (i !== fr) cells.push([i, fc]);
  }
  const empty = cells.filter(([r, c]) => !cellAt(s, r, c) && !lit.has(key(r, c)));
  if (empty.length) {
    if (!s.stack.length) {
      lose(s, `${p.name} falls through the void with no light left to land by. The souls are lost.`);
      return;
    }
    s.awaiting = {
      type: 'fall-landing', seat: p.seat,
      options: empty.map(([r, c]) => ({ r, c, draw: true })),
    };
    return;
  }
  // no empty spaces: land on an existing unoccupied tile in the row/column
  let existing = cells.filter(([r, c]) => tileAt(s, r, c) && !occupantsAt(s, r, c).length);
  if (!existing.length) {
    // desperate: anywhere on the board
    existing = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      if (tileAt(s, r, c) && !occupantsAt(s, r, c).length) existing.push([r, c]);
    }
  }
  if (!existing.length) {
    lose(s, `${p.name} can find nothing to land on. The void keeps them.`);
    return;
  }
  s.awaiting = {
    type: 'fall-landing', seat: p.seat,
    options: existing.map(([r, c]) => ({ r, c, draw: false })),
  };
};

STEPS['action'] = (s) => {
  if (s.phase !== 'play') return;
  const p = P(s, s.turn);
  const opts = actionOptions(s, p);
  s.awaiting = { type: 'action', seat: s.turn, ...opts };
};

STEPS['stay-fracture'] = (s) => {
  const p = P(s, s.turn);
  const t = tileAt(s, p.r, p.c);
  if (t && t.fractured) {
    const cellKey = key(p.r, p.c);
    const trig = triggeredBy(s, [cellKey]); // pre-flip: the draugr saw you drop
    const [r, c] = [p.r, p.c];
    fractureCell(s, r, c);
    p.placed = false; p.r = null; p.c = null;
    p.falling = { r, c };
    ev(s, 'fall', { seat: p.seat, from: [r, c], r, c });
    log(s, `${p.name} falls as the path crumbles beneath them!`, 'danger');
    s.queue.unshift({ t: 'end-turn' });
    startHitWave(s, trig, { mover: p.seat, lateral: false });
    return;
  }
  s.queue.unshift({ t: 'relight', chooser: s.turn }, { t: 'end-turn' });
};

STEPS['hit'] = (s, { seat, m }) => {
  const p = P(s, seat);
  if (!p.placed) return; // fell out of sight mid-wave (shouldn't happen)
  if (p.resolve > 0) {
    s.pendingHit = { seat, m };
    s.awaiting = { type: 'block', seat, m };
    return;
  }
  applyHit(s, seat, 3, false);
};

function applyHit(s, seat, n, braced) {
  const p = P(s, seat);
  ev(s, 'hit', { seat, n });
  discardN(s, n);
  p.hopeful = false;
  if (s.moveCtx && s.moveCtx.mover === seat) s.moveCtx.moverHit = true;
  log(s, braced
    ? `${p.name} braces against the Draugr — 2 tiles lost, hope extinguished.`
    : `${p.name} is struck by the Draugr — 3 tiles lost, hope extinguished.`, 'danger');
}

STEPS['after-hits'] = (s) => {
  const ctx = s.moveCtx;
  if (ctx && ctx.lateral && ctx.triggered > 0 && !ctx.moverHit) {
    const p = P(s, ctx.mover);
    if (p.placed && p.resolve < 2) {
      p.resolve++;
      log(s, `${p.name} slips past the Draugr's gaze — Resolve steeled (+1).`, 'good');
    } else if (p.placed) {
      log(s, `${p.name} slips past the Draugr's gaze.`, 'good');
    }
  }
  sweep(s);
  lossCheck(s);
};

STEPS['arrive'] = (s, { seat, then }) => {
  const p = P(s, seat);
  if (!p.placed) { s.queue.unshift({ t: then === 'action' ? 'action' : 'post-move' }); return; }
  const t = tileAt(s, p.r, p.c);
  if (t && t.kind === 'rune') {
    s.queue.unshift({ t: 'arrive2', seat, then });
    s.awaiting = { type: 'attune', seat, taken: s.players.filter(q => q.rune).map(q => ({ seat: q.seat, ...q.rune })) };
    return;
  }
  STEPS['arrive2'](s, { seat, then });
};

STEPS['arrive2'] = (s, { seat, then }) => {
  const p = P(s, seat);
  winCheck(s);
  if (s.phase !== 'play') return;
  const steps = [];
  if (p.placed && p.hopeful) steps.push({ t: 'illum', forSeat: seat, chooser: s.turn });
  steps.push({ t: 'relight', chooser: s.turn });
  steps.push({ t: then === 'action' ? 'action' : 'post-move' });
  s.queue.unshift(...steps);
};

STEPS['relight'] = (s) => {
  const rekindled = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of s.players) {
      if (!p.placed || p.hopeful) continue;
      const t = tileAt(s, p.r, p.c);
      if (!t) continue;
      for (let d = 0; d < 4; d++) {
        if (!t.exits[d]) continue;
        const [nr, nc] = stepDir(p.r, p.c, d);
        const nt = tileAt(s, nr, nc);
        if (!nt || !nt.exits[OPP(d)]) continue;
        const q = occupantsAt(s, nr, nc).find(q => q.hopeful);
        if (q) {
          p.hopeful = true;
          rekindled.push(p.seat);
          ev(s, 'rekindle', { seat: p.seat });
          log(s, `${p.name}'s hope is rekindled by ${q.name}.`, 'good');
          changed = true;
          break;
        }
      }
    }
  }
  if (rekindled.length) {
    const steps = rekindled.map(seat => ({ t: 'illum', forSeat: seat, chooser: s.turn }));
    steps.push({ t: 'relight', chooser: s.turn }); // new tiles may connect more souls
    s.queue.unshift(...steps);
  }
};

STEPS['post-move'] = (s) => {
  if (s.phase !== 'play') return;
  const p = P(s, s.turn);
  if (!p.placed) { s.queue.unshift({ t: 'end-turn' }); return; }
  const moves = computeMoves(s, p);
  const canMoveAgain = p.resolve > 0 && s.movesThisTurn < 3 && moves.length > 0;
  s.awaiting = { type: 'post-move', seat: s.turn, canMoveAgain, moves };
};

STEPS['end-turn'] = (s) => {
  if (s.phase !== 'play') return;
  if (!s.stack.length && !s.niflheim) {
    s.niflheim = true;
    log(s, 'The last flicker of the path stack dies. NIFLHEIM’S EMBRACE begins.', 'danger');
  }
  if (s.niflheim) {
    const removable = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      const t = tileAt(s, r, c);
      if (t && t.kind !== 'gate' && !occupantsAt(s, r, c).length) removable.push({ r, c });
    }
    if (removable.length) {
      const p = P(s, s.turn);
      s.queue.unshift({ t: 'end-turn2' });
      s.awaiting = { type: 'niflheim', seat: s.turn, canSustain: p.resolve > 0, options: removable };
      return;
    }
  }
  STEPS['end-turn2'](s);
};

STEPS['end-turn2'] = (s) => {
  lossCheck(s);
  if (s.phase !== 'play') return;
  s.turn = (s.turn + 1) % 4;
  s.movesThisTurn = 0;
  s.queue.unshift({ t: 'begin-turn' });
};

STEPS['scramble'] = (s, { seat, from, free, then }) => {
  const p = P(s, seat);
  const [fr, fc] = from;
  const srcTile = tileAt(s, fr, fc); // may be null if it became a rift
  const options = [];
  for (let d = 0; d < 4; d++) {
    if (!free && srcTile && !srcTile.exits[d]) continue;
    const [nr, nc] = stepDir(fr, fc, d);
    const cl = cellAt(s, nr, nc);
    if (cl && cl.rift) continue;
    const nt = cl && cl.tile;
    if (nt) {
      if (nt.kind === 'draugr') continue; // never scramble onto a visible draugr
      if (!free && !nt.exits[OPP(d)]) continue;
      if (nt.kind !== 'gate' && occupantsAt(s, nr, nc).length) continue;
      options.push({ r: nr, c: nc, d, draw: false });
    } else if (s.stack.length > 0) {
      options.push({ r: nr, c: nc, d, draw: true });
    }
  }
  if (!options.length) {
    // nowhere to scramble: the soul drops into the dark
    p.placed = false; p.r = null; p.c = null;
    p.falling = { r: fr, c: fc };
    ev(s, 'fall', { seat: p.seat, from: [fr, fc], r: fr, c: fc });
    log(s, `${p.name} has nowhere to scramble — they tumble into the dark!`, 'danger');
    sweep(s);
    s.queue.unshift({ t: 'end-turn' });
    return;
  }
  s.awaiting = { type: 'scramble', seat, from: { r: fr, c: fc }, free: !!free, then, options };
};

STEPS['landing-monster-after'] = (s, { seat, cell, then }) => {
  // the draugr that was landed on collapses into a rift, then the soul scrambles
  const [r, c] = cell;
  const t = tileAt(s, r, c);
  if (t && t.kind === 'draugr') {
    s.discard.push(t);
    s.grid[key(r, c)] = { rift: true };
    log(s, 'The Draugr collapses into a Void Rift beneath them!', 'danger');
  }
  s.queue.unshift({ t: 'scramble', seat, from: cell, free: true, then });
};

// ---------------------------------------------------------------- actions

export function applyAction(s, seat, payload) {
  if (s.phase === 'won' || s.phase === 'lost') err('The game is over.');
  const aw = s.awaiting;
  if (!aw) err('No action is awaited.');
  if (aw.seat !== seat) err('It is not this soul’s decision.');
  const handler = ACTIONS[aw.type];
  if (!handler) err('Unknown decision type.');
  s.events = []; // each action broadcast carries only its own events
  handler(s, P(s, seat), payload, aw);
  run(s);
  return s;
}

const ACTIONS = {};

ACTIONS['place-start'] = (s, p, { r, c, rot }) => {
  validCell(r, c); validRot(rot);
  if (cellAt(s, r, c)) err('That space is taken.');
  s.awaiting = null;
  const def = makeTileDef(s, 'start', { fractured: true });
  setTile(s, r, c, def, rot);
  p.r = r; p.c = c; p.placed = true;
  ev(s, 'reveal', { r, c });
  ev(s, 'land', { seat: p.seat, r, c });
  log(s, `${p.name} awakens in a forest clearing.`, 'info');
  s.queue.unshift({ t: 'illum', forSeat: p.seat, chooser: p.seat }, { t: 'setup', seat: p.seat + 1 });
};

ACTIONS['place-tile'] = (s, p, { r, c, rot }, aw) => {
  const target = aw.targets.find(t => t.r === r && t.c === c);
  if (!target) err('Not a legal space for this tile.');
  if (!target.rots.includes(rot)) err('That rotation does not connect.');
  s.awaiting = null;
  setTile(s, r, c, aw.tile, rot);
  ev(s, 'reveal', { r, c });
  if (aw.tile.kind === 'gate') log(s, `The Gate of ${GATE_NAMES[aw.tile.gate]} looms out of the mist!`, 'good');
  else if (aw.tile.kind === 'draugr') log(s, 'A Draugr stands silent in the newly lit path...', 'danger');
  else if (aw.tile.kind === 'rune') log(s, 'A Rune Circle is revealed.', 'good');
  s.queue.unshift({ t: 'illum', forSeat: aw.forSeat, chooser: aw.seat });
};

ACTIONS['action'] = (s, p, payload, aw) => {
  const kind = payload.kind;
  if (kind === 'rekindle') {
    if (!aw.rekindle) err('Cannot rekindle.');
    s.awaiting = null;
    p.resolve--;
    p.hopeful = true;
    ev(s, 'rekindle', { seat: p.seat });
    log(s, `${p.name} spends Resolve to rekindle their hope.`, 'good');
    s.queue.unshift({ t: 'illum', forSeat: p.seat, chooser: p.seat }, { t: 'relight', chooser: s.turn }, { t: 'action' });
    return;
  }
  if (kind === 'stay') {
    if (!aw.stay) err('Cannot stay.');
    s.awaiting = null;
    doStay(s, p, aw);
    return;
  }
  if (kind === 'move') {
    const mv = aw.moves.find(m => m.d === payload.d);
    if (!mv) err('Not a legal move.');
    s.awaiting = null;
    s.movesThisTurn = (s.movesThisTurn || 0) + 1;
    doMove(s, p, mv, 'post-move');
    return;
  }
  err('Unknown action.');
};

function doStay(s, p, aw) {
  ev(s, 'stay', { seat: p.seat });
  const forced = !p.hopeful && aw.moves.length === 0 && p.resolve === 0;
  if (!p.hopeful && !forced) {
    p.resolve--;
    log(s, `${p.name} spends Resolve to endure the mist, hopeless and still.`, 'info');
  } else if (p.hopeful) {
    if (p.resolve < 2) p.resolve++;
    log(s, `${p.name} stands fast and steels their Resolve (+1).`, 'info');
  } else {
    log(s, `${p.name} is trapped, hopeless and unmoving.`, 'info');
  }
  // staying burns hope
  if (s.stack.length) {
    const t = drawTile(s);
    if (t.kind === 'draugr') {
      // it does not go quietly: replace a connected tile
      const myT = tileAt(s, p.r, p.c);
      const options = [];
      for (let d = 0; d < 4; d++) {
        if (!myT || !myT.exits[d]) continue;
        const [nr, nc] = stepDir(p.r, p.c, d);
        const nt = tileAt(s, nr, nc);
        if (!nt || !nt.exits[OPP(d)]) continue;
        if (nt.kind === 'gate' || nt.kind === 'draugr') continue;
        if (occupantsAt(s, nr, nc).length) continue;
        options.push({ r: nr, c: nc });
      }
      if (options.length) {
        log(s, `${p.name} hears something move in the mist...`, 'danger');
        s.queue.unshift({ t: 'stay-fracture' });
        s.awaiting = { type: 'swap-draugr', seat: p.seat, tile: t, options };
        return;
      }
      s.discard.push(t);
      ev(s, 'burn', { n: 1 });
      log(s, 'A Draugr stirs in the mist, finds no path, and sinks away.', 'info');
    } else {
      s.discard.push(t);
      ev(s, 'burn', { n: 1 });
      if (t.kind === 'gate') log(s, `The Gate of ${GATE_NAMES[t.gate]} is lost to the mist!`, 'danger');
      else if (t.kind === 'rune') log(s, 'A Rune Circle is lost from the path stack.', 'danger');
      else log(s, 'Standing still burns hope — a path tile is lost.', 'info');
    }
  }
  s.queue.unshift({ t: 'stay-fracture' });
}

ACTIONS['swap-draugr'] = (s, p, { r, c }, aw) => {
  if (!aw.options.some(o => o.r === r && o.c === c)) err('Not a connected tile.');
  s.awaiting = null;
  const old = tileAt(s, r, c);
  s.discard.push(old);
  setTile(s, r, c, aw.tile, 0);
  ev(s, 'reveal', { r, c });
  log(s, `A Draugr claws its way onto the path beside ${p.name}!`, 'danger');
  // continuation (stay-fracture) is already queued
};

function doMove(s, p, mv, then) {
  const { d, kind } = mv;
  const [or_, oc] = [p.r, p.c];
  const originKey = key(or_, oc);
  const [nr, nc] = [mv.r, mv.c];
  const destKey = key(nr, nc);
  const originTile = tileAt(s, or_, oc);
  const originFractured = originTile && originTile.fractured;

  if (kind === 'jump') {
    log(s, `${p.name} leaps into the Void Rift.`, 'info');
    const trig = triggeredBy(s, [originKey]);
    ev(s, 'fall', { seat: p.seat, from: [or_, oc], r: nr, c: nc });
    if (originFractured) fractureCell(s, or_, oc);
    p.placed = false; p.r = null; p.c = null;
    p.falling = { r: nr, c: nc };
    s.queue.unshift({ t: 'end-turn' });
    startHitWave(s, trig, { mover: p.seat, lateral: false });
    return;
  }

  if (kind === 'charge') {
    if (p.resolve < 1) err('No Resolve to charge.');
    p.resolve--;
    log(s, `${p.name} charges the Draugr!`, 'danger');
    const trig = triggeredBy(s, [originKey, destKey]);
    p.r = nr; p.c = nc;
    ev(s, 'move', { seat: p.seat, from: [or_, oc], to: [nr, nc] });
    if (originFractured) fractureCell(s, or_, oc);
    s.queue.unshift({ t: 'scramble', seat: p.seat, from: [nr, nc], free: false, then });
    startHitWave(s, trig, { mover: p.seat, lateral: false });
    return;
  }

  if (kind === 'blind') {
    const tile = drawTile(s);
    if (!tile) err('No tiles left to reveal.');
    if (tile.kind === 'draugr') {
      setTile(s, nr, nc, tile, 0);
      log(s, `${p.name} stumbles blindly onto a Draugr!`, 'danger');
      const trig = triggeredBy(s, [originKey, destKey]);
      p.r = nr; p.c = nc;
      ev(s, 'reveal', { r: nr, c: nc });
      ev(s, 'move', { seat: p.seat, from: [or_, oc], to: [nr, nc] });
      if (originFractured) fractureCell(s, or_, oc);
      s.queue.unshift({ t: 'scramble', seat: p.seat, from: [nr, nc], free: false, then });
      startHitWave(s, trig, { mover: p.seat, lateral: false });
      return;
    }
    const rots = [0, 1, 2, 3].filter(rot => exitsFor(tile.kind, rot)[OPP(d)]);
    s.blindCtx = { origin: [or_, oc], d, then, originFractured };
    s.awaiting = { type: 'place-blind', seat: p.seat, tile, r: nr, c: nc, rots };
    return;
  }

  // normal move (incl. onto gates)
  log(s, `${p.name} moves ${DIRNAMES[d]}.`, 'info');
  const trig = triggeredBy(s, [originKey, destKey]);
  p.r = nr; p.c = nc;
  ev(s, 'move', { seat: p.seat, from: [or_, oc], to: [nr, nc] });
  if (originFractured) fractureCell(s, or_, oc);
  s.queue.unshift({ t: 'arrive', seat: p.seat, then });
  startHitWave(s, trig, { mover: p.seat, lateral: true });
}

ACTIONS['place-blind'] = (s, p, { rot }, aw) => {
  if (!aw.rots.includes(rot)) err('That rotation does not connect.');
  s.awaiting = null;
  const { origin, then, originFractured } = s.blindCtx;
  s.blindCtx = null;
  setTile(s, aw.r, aw.c, aw.tile, rot);
  const originKey = key(origin[0], origin[1]);
  const destKey = key(aw.r, aw.c);
  const trig = triggeredBy(s, [originKey, destKey]);
  p.r = aw.r; p.c = aw.c;
  ev(s, 'reveal', { r: aw.r, c: aw.c });
  ev(s, 'move', { seat: p.seat, from: origin, to: [aw.r, aw.c] });
  if (originFractured) fractureCell(s, origin[0], origin[1]);
  log(s, `${p.name} feels their way onto ${describeTile(aw.tile)}.`, 'info');
  s.queue.unshift({ t: 'arrive', seat: p.seat, then });
  startHitWave(s, trig, { mover: p.seat, lateral: true });
};

ACTIONS['block'] = (s, p, { block }) => {
  const { seat } = s.pendingHit;
  s.pendingHit = null;
  s.awaiting = null;
  if (block) {
    if (p.resolve < 1) err('No Resolve to brace with.');
    p.resolve--;
    applyHit(s, seat, 2, true);
  } else {
    applyHit(s, seat, 3, false);
  }
};

ACTIONS['attune'] = (s, p, payload) => {
  s.awaiting = null;
  if (payload.skip) {
    log(s, `${p.name} leaves the runes untouched.`, 'info');
    return;
  }
  const { p: pantheon, k } = payload;
  const set = RUNES[pantheon];
  if (!set || !set.some(r => r.k === k)) err('No such rune.');
  p.rune = { p: pantheon, k };
  const r = set.find(r => r.k === k);
  ev(s, 'rune', { seat: p.seat });
  log(s, `${p.name} is marked with ${r.name} ${r.g} (${GATE_NAMES[pantheon]}).`, 'good');
  winCheck(s);
};

ACTIONS['fall-landing'] = (s, p, { r, c }, aw) => {
  const opt = aw.options.find(o => o.r === r && o.c === c);
  if (!opt) err('Cannot land there.');
  s.awaiting = null;
  if (opt.draw) {
    const tile = drawTile(s);
    if (!tile) { lose(s, `${p.name} falls through the void with no light left to land by.`); return; }
    if (tile.kind === 'draugr') {
      setTile(s, r, c, tile, 0);
      landSoul(s, p, r, c);
      log(s, `${p.name} lands on a Draugr!`, 'danger');
      s.queue.unshift({ t: 'landing-monster-after', seat: p.seat, cell: [r, c], then: 'action' });
      startHitWave(s, [[r, c]], { mover: p.seat, lateral: false }); // only the landed-on draugr attacks (plus chains)
      return;
    }
    s.awaiting = { type: 'place-landing', seat: p.seat, tile, r, c, rots: [0, 1, 2, 3] };
    return;
  }
  // landing on an existing tile
  const t = tileAt(s, r, c);
  if (t.kind === 'draugr') {
    landSoul(s, p, r, c);
    log(s, `${p.name} lands on a Draugr!`, 'danger');
    s.queue.unshift({ t: 'landing-monster-after', seat: p.seat, cell: [r, c], then: 'action' });
    startHitWave(s, [[r, c]], { mover: p.seat, lateral: false });
    return;
  }
  landSoul(s, p, r, c);
  s.queue.unshift({ t: 'arrive', seat: p.seat, then: 'action' });
};

ACTIONS['place-landing'] = (s, p, { rot }, aw) => {
  if (!aw.rots.includes(rot)) err('Bad rotation.');
  s.awaiting = null;
  setTile(s, aw.r, aw.c, aw.tile, rot);
  ev(s, 'reveal', { r: aw.r, c: aw.c });
  landSoul(s, p, aw.r, aw.c);
  s.queue.unshift({ t: 'arrive', seat: p.seat, then: 'action' });
};

function landSoul(s, p, r, c) {
  p.falling = null;
  p.placed = true;
  p.r = r; p.c = c;
  p.hopeful = false; // Mirkwood: souls land hopeless
  ev(s, 'land', { seat: p.seat, r, c });
  log(s, `${p.name} falls back into Myrkviðr, hope extinguished.`, 'info');
}

ACTIONS['scramble'] = (s, p, { r, c }, aw) => {
  const opt = aw.options.find(o => o.r === r && o.c === c);
  if (!opt) err('Cannot scramble there.');
  s.awaiting = null;
  const then = aw.then;
  if (!opt.draw) {
    ev(s, 'move', { seat: p.seat, from: [aw.from.r, aw.from.c], to: [r, c] });
    p.r = r; p.c = c; p.placed = true; p.falling = null;
    log(s, `${p.name} scrambles away.`, 'info');
    s.queue.unshift({ t: 'arrive', seat: p.seat, then });
    return;
  }
  const tile = drawTile(s);
  if (!tile) {
    // stack ran dry between option calc and now (shouldn't happen), fall
    p.placed = false; p.falling = { r: aw.from.r, c: aw.from.c };
    s.queue.unshift({ t: 'end-turn' });
    return;
  }
  if (tile.kind === 'draugr') {
    setTile(s, r, c, tile, 0);
    ev(s, 'reveal', { r, c });
    ev(s, 'move', { seat: p.seat, from: [aw.from.r, aw.from.c], to: [r, c] });
    p.r = r; p.c = c; p.placed = true; p.falling = null;
    log(s, `${p.name} scrambles straight onto another Draugr!`, 'danger');
    s.queue.unshift({ t: 'scramble', seat: p.seat, from: [r, c], free: false, then });
    startHitWave(s, [[r, c]], { mover: p.seat, lateral: false });
    return;
  }
  const rots = aw.free
    ? [0, 1, 2, 3]
    : [0, 1, 2, 3].filter(rot => exitsFor(tile.kind, rot)[OPP(opt.d)]);
  s.blindCtx = { scramble: true, then, from: [aw.from.r, aw.from.c] };
  s.awaiting = { type: 'place-scramble', seat: p.seat, tile, r, c, rots };
};

ACTIONS['place-scramble'] = (s, p, { rot }, aw) => {
  if (!aw.rots.includes(rot)) err('Bad rotation.');
  s.awaiting = null;
  const { then, from } = s.blindCtx;
  s.blindCtx = null;
  setTile(s, aw.r, aw.c, aw.tile, rot);
  ev(s, 'reveal', { r: aw.r, c: aw.c });
  if (from) ev(s, 'move', { seat: p.seat, from, to: [aw.r, aw.c] });
  p.r = aw.r; p.c = aw.c; p.placed = true; p.falling = null;
  log(s, `${p.name} scrambles onto ${describeTile(aw.tile)}.`, 'info');
  s.queue.unshift({ t: 'arrive', seat: p.seat, then });
};

ACTIONS['post-move'] = (s, p, payload, aw) => {
  if (payload.kind === 'end') {
    s.awaiting = null;
    s.queue.unshift({ t: 'end-turn' });
    return;
  }
  if (payload.kind === 'move') {
    if (!aw.canMoveAgain) err('Cannot move again.');
    const mv = aw.moves.find(m => m.d === payload.d);
    if (!mv) err('Not a legal move.');
    if (p.resolve < 1) err('No Resolve.');
    s.awaiting = null;
    p.resolve--;
    s.movesThisTurn = (s.movesThisTurn || 0) + 1;
    log(s, `${p.name} pushes on, spending Resolve to move again.`, 'info');
    doMove(s, p, mv, 'post-move');
    return;
  }
  err('Unknown choice.');
};

ACTIONS['niflheim'] = (s, p, payload, aw) => {
  if (payload.sustain) {
    if (!aw.canSustain || p.resolve < 1) err('Cannot sustain.');
    s.awaiting = null;
    p.resolve--;
    log(s, `${p.name} spends Resolve to sustain the paths against Niflheim.`, 'good');
    return;
  }
  const opt = aw.options.find(o => o.r === payload.r && o.c === payload.c);
  if (!opt) err('Cannot remove that tile.');
  s.awaiting = null;
  const t = tileAt(s, payload.r, payload.c);
  s.discard.push(t);
  s.grid[key(payload.r, payload.c)] = null;
  ev(s, 'sweep', { cells: [{ r: payload.r, c: payload.c, tile: t, rift: false }] });
  log(s, `Niflheim's cold claims ${describeTile(t)}.`, 'danger');
};

export function concede(s) {
  lose(s, 'The souls surrender their hope to Niflheim.');
  return s;
}

function validCell(r, c) {
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= SIZE || c < 0 || c >= SIZE) err('Bad cell.');
}
function validRot(rot) {
  if (![0, 1, 2, 3].includes(rot)) err('Bad rotation.');
}

// ---------------------------------------------------------------- public view

export function publicState(s) {
  return {
    phase: s.phase,
    grid: s.grid,
    players: s.players,
    turn: s.turn,
    awaiting: s.awaiting,
    niflheim: s.niflheim,
    winnerGate: s.winnerGate,
    lossReason: s.lossReason,
    log: s.log.slice(-120),
    discard: s.discard,
    stackCount: s.stack.length,
    events: s.events,
    lit: [...litSet(s)],
  };
}

// test hooks
export const _test = {
  tileAt, cellAt, setTile, makeTileDef, sweep, run, STEPS,
  triggeredBy, expandChains, occupantsAt,
};

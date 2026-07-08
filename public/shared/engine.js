/*
 * Mirkwood — authoritative game engine.
 * Pure logic, no I/O. Shared by the Node server and (for constants/helpers)
 * the browser client.
 *
 * Board: 6x6, edges wrap (the forest loops).
 * Directions: 0=N 1=E 2=S 3=W.
 */

// Bump when the state shape changes incompatibly: rooms persisted with an
// older version are gracefully reset by the worker instead of crashing.
export const STATE_VERSION = 2; // v2: rune realignment (ansuz→valhalla, fehu in, isa out)

export const SIZE = 6;
export const DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]];
export const DIRNAMES = ['north', 'east', 'south', 'west'];
export const OPP = d => (d + 2) % 4;

// Odin's gate bears Odin's rune (Ansuz); Freyja's gate bears the Vanir's
// wealth-rune (Fehu). Isa is retired — ice belongs to Niflheim, not paradise.
export const RUNES = {
  valhalla: [
    { k: 'thurisaz', g: 'ᚦ', name: 'Thurisaz', gloss: 'Thorn — strength and defense' },
    { k: 'eihwaz',   g: 'ᛇ', name: 'Eihwaz',   gloss: 'Yew — endurance beyond death' },
    { k: 'raido',    g: 'ᚱ', name: 'Raido',    gloss: 'Ride — the righteous path' },
    { k: 'ansuz',    g: 'ᚨ', name: 'Ansuz',    gloss: "God — wisdom and Odin's insight" },
  ],
  folkvangr: [
    { k: 'berkano', g: 'ᛒ', name: 'Berkano', gloss: 'Birch — nurture and protection' },
    { k: 'uruz',    g: 'ᚢ', name: 'Uruz',    gloss: 'Aurochs — vitality and growth' },
    { k: 'wunjo',   g: 'ᚹ', name: 'Wunjo',   gloss: 'Joy — harmony and fulfilment' },
    { k: 'fehu',    g: 'ᚠ', name: 'Fehu',    gloss: "Cattle — wealth, Freyja's plenty" },
  ],
};
export const GATE_NAMES = { valhalla: 'Valhalla', folkvangr: 'Fólkvangr' };

// eight soul colors, tuned to read against the near-black board and against
// each other (the first four are the original seat defaults)
export const PLAYER_COLORS = ['#e8b23c', '#d05e5e', '#4fb8a8', '#a678d8', '#7fa8dc', '#a3b555', '#d9d3c0', '#c97ba4'];
export const PLAYER_COLOR_NAMES = ['Gold', 'Ember', 'Teal', 'Violet', 'Ice', 'Moss', 'Bone', 'Heather'];

// eight Norse sigils a soul may bear as its token, authored in a 24×24 box;
// "CUR" is replaced with the drawing color at render time
export const TOKEN_ICONS = {
  // nasal helm: domed cap on a brow band with a nose guard hanging down
  helm: { name: 'Helm', art: '<path d="M5 12 C5 6.5 8 3 12 3 C16 3 19 6.5 19 12 Z" fill="CUR"/><path d="M3.8 11.8 H20.2 V14 H3.8 Z" fill="CUR"/><path d="M10.7 14 H13.3 V18.6 L12 19.6 L10.7 18.6 Z" fill="CUR"/>' },
  // round shield: rim, central boss, radial planks
  shield: { name: 'Shield', art: '<circle cx="12" cy="12" r="9.2" fill="none" stroke="CUR" stroke-width="1.9"/><circle cx="12" cy="12" r="2.5" fill="CUR"/><path d="M12 3.2 V20.8 M3.2 12 H20.8 M5.8 5.8 L18.2 18.2 M18.2 5.8 L5.8 18.2" stroke="CUR" stroke-width="1.1" fill="none"/>' },
  // sword point-down: round pommel, grip, crossguard, tapering blade
  sword: { name: 'Sword', art: '<circle cx="12" cy="3.3" r="1.8" fill="CUR"/><rect x="11.1" y="4.7" width="1.8" height="3" fill="CUR"/><rect x="6" y="7.5" width="12" height="2.2" rx="1.1" fill="CUR"/><path d="M10.2 10 H13.8 L12.9 20 L12 21.8 L11.1 20 Z" fill="CUR"/>' },
  // Mjölnir hung as a pendant: ring, short haft, blocky head with a flared skirt
  hammer: { name: 'Mjölnir', art: '<circle cx="12" cy="3.2" r="1.7" fill="none" stroke="CUR" stroke-width="1.4"/><path d="M10.5 4.8 H13.5 V11.5 H10.5 Z" fill="CUR"/><path d="M5 11.5 H19 V15.5 L20.5 20 H3.5 L5 15.5 Z" fill="CUR"/>' },
  // longship: bold crescent hull, up-swept dragon posts, mast, billowing sail
  ship: { name: 'Longship', art: '<path d="M2.2 11.4 C5.5 17 18.5 17 21.8 11.4 C17 13.6 7 13.6 2.2 11.4 Z" fill="CUR"/><path d="M3.4 11.8 C1.9 7.8 2.3 4.8 4.2 3.4 M20.6 11.8 C22.1 7.8 21.7 4.8 19.8 3.4" stroke="CUR" stroke-width="2.1" fill="none" stroke-linecap="round"/><path d="M12 11.8 V4.4" stroke="CUR" stroke-width="2" fill="none"/><path d="M7 4.8 H17 V9.2 C13 11.4 11 11.4 7 9.2 Z" fill="CUR"/>' },
  // raven perched in profile, facing right — stout beak, long tail, gripping feet
  raven: { name: 'Raven', art: '<path d="M21 6.2 C19 5.4 16 3.8 13.5 4.3 C10.5 5 8.5 6.5 7 8.5 C5 11 3.5 13.5 2 18.5 L3.8 19 C6 16.5 9 15.2 11.5 14.8 C14 14.6 16.5 13.8 17.8 11.8 C18.6 10.3 18.4 8.5 18.8 7.3 C19.4 6.9 20.2 6.5 21 6.2 Z" fill="CUR"/><path d="M11.4 15 L11 19.8 M11 19.8 L9.6 20.8 M11 19.8 L12.3 20.8 M14.3 14.7 L14.3 19.8 M14.3 19.8 L12.9 20.8 M14.3 19.8 L15.6 20.8" stroke="CUR" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' },
  // drinking horn: wide rim at the mouth tapering to a point
  horn: { name: 'Horn', art: '<path d="M4.2 4.2 C7 3 9.2 4 9.8 6.4 C12 13 16 18 20.6 20 L19.8 21.4 C14.5 18.6 9.4 13.4 6.3 8 C5 5.9 3.5 5 4.2 4.2 Z" fill="CUR"/><ellipse cx="6.3" cy="4.9" rx="3.1" ry="1.8" fill="CUR" transform="rotate(30 6.3 4.9)"/>' },
  // valknut: three thin heavily-overlapping triangles — inner triangles show through
  valknut: { name: 'Valknut', art: '<g fill="none" stroke="CUR" stroke-width="1.5" stroke-linejoin="round"><path d="M9 2.5 L16 16 L2 16 Z"/><path d="M15 2.5 L22 16 L8 16 Z"/><path d="M12 7 L18.5 20 L5.5 20 Z"/></g>' },
};
export const TOKEN_ICON_KEYS = Object.keys(TOKEN_ICONS);

// a sigil scaled into a box whose top-left corner is (x, y)
export function iconSVG(key, x, y, size, color) {
  const ic = TOKEN_ICONS[key];
  if (!ic) return '';
  return `<g transform="translate(${x} ${y}) scale(${size / 24})">${ic.art.replaceAll('CUR', color)}</g>`;
}

export const DEFAULT_NAMES = ['Astrid', 'Bjorn', 'Sigrun', 'Torvald'];

// Difficulty presets and tile-count sanitizer. The host may start from a
// preset or edit every count; ranges are clamped so a game is always playable.
export const TILE_PRESETS = {
  normal: { straight: 10, tee: 30, teeFractured: 2, cross: 12, rune: 6, draugr: 12, gateValhalla: 1, gateFolkvangr: 1 },
  hard:   { straight: 10, tee: 26, teeFractured: 5, cross: 10, rune: 5, draugr: 15, gateValhalla: 1, gateFolkvangr: 1 },
};

export function normTiles(cfg) {
  const out = { ...TILE_PRESETS.normal };
  if (cfg) {
    for (const k of Object.keys(out)) {
      if (cfg[k] !== undefined && cfg[k] !== null) out[k] = Math.max(0, Math.min(60, cfg[k] | 0));
    }
  }
  out.rune = Math.max(4, Math.min(12, out.rune));     // fewer than 4 circles is instant defeat
  out.straight = Math.max(2, out.straight);            // opening draw needs plain paths
  out.tee = Math.max(4, out.tee);
  out.cross = Math.max(2, out.cross);
  out.draugr = Math.min(24, out.draugr);
  out.gateValhalla = out.gateValhalla ? 1 : 0;
  out.gateFolkvangr = out.gateFolkvangr ? 1 : 0;
  if (!out.gateValhalla && !out.gateFolkvangr) out.gateValhalla = 1; // at least one way out
  return out;
}

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

function buildStack(s, C) {
  const pool = [];
  for (let i = 0; i < C.straight; i++) pool.push(makeTileDef(s, 'straight', { fractured: true }));
  for (let i = 0; i < C.tee; i++) pool.push(makeTileDef(s, 'tee'));
  for (let i = 0; i < C.teeFractured; i++) pool.push(makeTileDef(s, 'tee', { fractured: true }));
  for (let i = 0; i < C.cross; i++) pool.push(makeTileDef(s, 'cross'));
  for (let i = 0; i < C.rune; i++) pool.push(makeTileDef(s, 'rune', { fractured: true }));
  for (let i = 0; i < C.draugr; i++) pool.push(makeTileDef(s, 'draugr'));
  if (C.gateValhalla) pool.push(makeTileDef(s, 'gate', { gate: 'valhalla' }));
  if (C.gateFolkvangr) pool.push(makeTileDef(s, 'gate', { gate: 'folkvangr' }));

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
    v: STATE_VERSION,
    startedAt: Date.now(),
    turnsTaken: 0,
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
    events: [],     // ordered semantic events of the current action, for live animation
    turnEvents: [], // events accumulated across the whole current turn
    lastTurn: null, // { seat, events } of the last completed turn, for Replay
    turnOwner: null,
    rngState: (opts.seed ?? Math.floor(Math.random() * 2 ** 31)) | 0,
    tileSeq: 0,
    moveCtx: null,
    pendingHit: null,
    blindCtx: null,
    movesThisTurn: 0,
    randomRunes: !!opts.randomRunes, // host variant: the stones choose your mark
  };
  const names = opts.names || DEFAULT_NAMES;
  const looks = opts.appearance || []; // per seat: {color, icon} chosen in the lobby
  for (let i = 0; i < 4; i++) {
    const look = looks[i] || {};
    s.players.push({
      seat: i,
      name: names[i] || DEFAULT_NAMES[i],
      color: PLAYER_COLORS.includes(look.color) ? look.color : PLAYER_COLORS[i],
      icon: TOKEN_ICONS[look.icon] ? look.icon : TOKEN_ICON_KEYS[i],
      r: null, c: null,
      placed: false,
      hopeful: true,
      resolve: 1,
      rune: null,      // {p:'valhalla'|'folkvangr', k}
      falling: null,   // {r,c} rift fallen through
    });
  }
  s.stack = opts.stack ? opts.stack.map(t => makeTileDef(s, t.kind, t)) : buildStack(s, normTiles(opts.tiles));
  // stack composition at the start of the saga — drives the discard tracker's
  // "lost X of Y" denominators whatever the difficulty or custom tile counts
  s.tileTotals = { rune: 0, draugr: 0, gate: 0 };
  for (const t of s.stack) if (t.kind in s.tileTotals) s.tileTotals[t.kind]++;
  const label = typeof opts.label === 'string' ? opts.label.slice(0, 12) : '';
  log(s, `The souls awaken beneath the boughs of Myrkviðr${label && label !== 'Normal' ? ` — a ${label} telling` : ''}.`, 'turn');
  s.queue.push({ t: 'setup', seat: 0 });
  run(s);
  return s;
}

function log(s, m, k = 'info') {
  s.log.push({ m, k });
  if (s.log.length > 250) s.log.splice(0, s.log.length - 250);
}

// semantic events in resolution order, consumed by the client's animation
// timeline; s.events is per action (cleared each applyAction), s.turnEvents
// accumulates across the whole turn for the Replay feature
function ev(s, e, data) {
  const entry = { e, ...data };
  s.events.push(entry);
  if (s.events.length > 80) s.events.splice(0, s.events.length - 80);
  if (!s.turnEvents) s.turnEvents = [];
  s.turnEvents.push(entry);
  if (s.turnEvents.length > 200) s.turnEvents.splice(0, s.turnEvents.length - 200);
}

function snapshotTurn(s, seat) {
  if (s.turnEvents && s.turnEvents.length) {
    s.lastTurn = { seat, events: s.turnEvents };
    s.turnEvents = [];
  }
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
    ? `${monsters.length} draugar shriek in a chain of spite!`
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
    // a spent circle no longer offers a mark: in the base game the stones
    // speak once — the soul standing there has had their choice, nobody else
    // can enter, and it crumbles the moment they leave. (Random Runes never
    // spends a circle: the occupant may linger and let the stones choose
    // again, so it keeps counting.)
    if (t && t.kind === 'rune' && !t.spent) n++;
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

// With the stack spent, a fall is almost always the end: landing on an empty
// space needs a draw that can never come. Say so the moment the soul falls —
// not a full round later when their landing turn comes up.
function fallDoomCheck(s, p) {
  if (s.stack.length || s.phase !== 'play') return;
  const lit = litSet(s);
  const { r: fr, c: fc } = p.falling;
  for (let i = 0; i < SIZE; i++) {
    for (const [r, c] of [[fr, i], [i, fc]]) {
      if (!cellAt(s, r, c) && !lit.has(key(r, c))) {
        lose(s, `${p.name} falls into the starless void — with the last hope spent, nothing will ever kindle a place to land. The souls are lost.`);
        return;
      }
    }
  }
}

// Niflheim's Embrace only ever shrinks the path network — no tile is ever
// added again. So the moment no gate remains that (a) all four souls can
// still reach and (b) whose four marks can still be completed at reachable
// circles, the saga is over. Void crossings are counted generously: a rift
// (or a fractured tile a soul could drop through) whose row and column hold
// no empty unlit cell still lets a faller land on an existing tile there.
function embraceDoomCheck(s) {
  if (!s.niflheim || s.phase !== 'play') return;
  if (!s.players.every(p => p.placed)) return; // a faller's own doom resolves first
  // connected components of the path network
  const comp = new Array(SIZE * SIZE).fill(-1);
  let nComp = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    if (comp[key(r, c)] !== -1 || !tileAt(s, r, c)) continue;
    const id = nComp++;
    const todo = [[r, c]];
    comp[key(r, c)] = id;
    while (todo.length) {
      const [cr, cc] = todo.pop();
      const t = tileAt(s, cr, cc);
      for (let d = 0; d < 4; d++) {
        if (!t.exits[d]) continue;
        const [nr, nc] = stepDir(cr, cc, d);
        const nt = tileAt(s, nr, nc);
        if (!nt || !nt.exits[OPP(d)] || comp[key(nr, nc)] !== -1) continue;
        comp[key(nr, nc)] = id;
        todo.push([nr, nc]);
      }
    }
  }
  const parent = [...Array(nComp).keys()];
  const find = a => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  // survivable void crossings merge components
  const lit = litSet(s);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const cl = cellAt(s, r, c);
    const src = [];
    if (cl && cl.rift) {
      for (let d = 0; d < 4; d++) {
        const [nr, nc] = stepDir(r, c, d);
        const nt = tileAt(s, nr, nc);
        if (nt && nt.exits[OPP(d)]) src.push(comp[key(nr, nc)]);
      }
    } else if (cl && cl.tile && cl.tile.fractured) {
      src.push(comp[key(r, c)]);
    }
    if (!src.length) continue;
    let deadly = false;
    const targets = new Set();
    for (let i = 0; i < SIZE; i++) {
      for (const [lr, lc] of [[r, i], [i, c]]) {
        if (!cellAt(s, lr, lc) && !lit.has(key(lr, lc))) deadly = true;
        else if (tileAt(s, lr, lc)) targets.add(comp[key(lr, lc)]);
      }
    }
    if (deadly) continue; // the jump means a draw that can never come
    for (const a of src) {
      if (targets.size) for (const b of targets) union(a, b);
      else for (let b = 0; b < nComp; b++) union(a, b); // desperate: land anywhere
    }
  }
  // some gate must be completable AND reachable by all four souls
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const t = tileAt(s, r, c);
    if (!t || t.kind !== 'gate') continue;
    const g = find(comp[key(r, c)]);
    if (!s.players.every(p => find(comp[key(p.r, p.c)]) === g)) continue;
    const held = new Set();
    for (const p of s.players) if (p.rune && p.rune.p === t.gate) held.add(p.rune.k);
    const needed = 4 - held.size;
    if (needed > 0) {
      let circles = 0;
      for (let rr = 0; rr < SIZE; rr++) for (let cc = 0; cc < SIZE; cc++) {
        const ct = tileAt(s, rr, cc);
        if (ct && ct.kind === 'rune' && !ct.spent && find(comp[key(rr, cc)]) === g) circles++;
      }
      if (circles < needed) continue;
    }
    return; // this gate can still be won
  }
  lose(s, 'The cold has severed every road — no soul may reach a gate whose runes could still be gathered. Niflheim claims them all.');
}

function lossCheck(s) {
  if (s.phase !== 'play') return;
  const gates = gatesLeft(s);
  if (gates.length === 0) {
    lose(s, 'Both gates are lost. Niflheim claims the souls forever.');
    return;
  }
  // enough Rune Circles must remain for the souls to finish a matching set:
  // for the best available gate, every soul not yet holding a distinct rune
  // of that gate needs one circle visit
  const circles = runeCirclesLeft(s);
  let needed = Infinity;
  for (const g of new Set(gates)) {
    const held = new Set();
    for (const p of s.players) {
      if (p.rune && p.rune.p === g) held.add(p.rune.k);
    }
    needed = Math.min(needed, 4 - held.size);
  }
  if (circles < needed) {
    lose(s, 'Too many Rune Circles are lost to the mist — the souls can never bear the four marks a gate demands.');
    return;
  }
  embraceDoomCheck(s);
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
  snapshotTurn(s, Math.min(3, Math.max(0, seat - 1)));
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
  snapshotTurn(s, s.turnOwner ?? s.turn);
  s.turnOwner = s.turn;
  s.turnsTaken = (s.turnsTaken || 0) + 1;
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
    // Random Runes: a soul may linger at a Rune Circle without it crumbling —
    // each turn spent Staying burns a tile as usual, but the stones choose
    // again, letting them fish for a mark that matches the party. The circle
    // still crumbles when they finally leave.
    if (s.randomRunes && t.kind === 'rune') {
      log(s, `${p.name} lingers in the Rune Circle — the stones stir again.`, 'info');
      s.queue.unshift({ t: 'relight', chooser: s.turn }, { t: 'end-turn' });
      s.awaiting = {
        type: 'attune', seat: p.seat, random: true,
        taken: s.players.filter(q => q.rune).map(q => ({ seat: q.seat, ...q.rune })),
      };
      return;
    }
    const cellKey = key(p.r, p.c);
    const trig = triggeredBy(s, [cellKey]); // pre-flip: the draugr saw you drop
    const [r, c] = [p.r, p.c];
    fractureCell(s, r, c);
    p.placed = false; p.r = null; p.c = null;
    p.falling = { r, c };
    ev(s, 'fall', { seat: p.seat, from: [r, c], r, c });
    log(s, `${p.name} falls as the path crumbles beneath them!`, 'danger');
    fallDoomCheck(s, p);
    if (s.phase !== 'play') return;
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
    s.awaiting = {
      type: 'attune', seat,
      random: !!s.randomRunes,
      taken: s.players.filter(q => q.rune).map(q => ({ seat: q.seat, ...q.rune })),
    };
    return;
  }
  STEPS['arrive2'](s, { seat, then });
};

STEPS['arrive2'] = (s, { seat, then }) => {
  const p = P(s, seat);
  winCheck(s);
  if (s.phase !== 'play') return;
  // the mist claims whatever no soul lights BEFORE hope can spread again —
  // a monster scrambled off in hopelessness fades even if the scrambler is
  // rekindled a heartbeat later
  sweep(s);
  // an incompatible rune taken at the last circle (or a circle lost to the
  // sweep) can decide the saga right here — say so now, not at end of turn
  lossCheck(s);
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
    // each rekindled soul reveals their own newly lit paths (playtest rule:
    // a player always places their own tiles, even mid another's turn)
    const steps = rekindled.map(seat => ({ t: 'illum', forSeat: seat, chooser: seat }));
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
    log(s, 'The path stack is spent — the last ember of shared hope goes dark. NIFLHEIM’S EMBRACE begins.', 'danger');
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

STEPS['scramble'] = (s, { seat, from, free, banish, then }) => {
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
    if (banish) banishCell(s, fr, fc);
    p.placed = false; p.r = null; p.c = null;
    p.falling = { r: fr, c: fc };
    ev(s, 'fall', { seat: p.seat, from: [fr, fc], r: fr, c: fc });
    log(s, `${p.name} finds no footing — they tumble into the dark!`, 'danger');
    sweep(s);
    fallDoomCheck(s, p);
    if (s.phase !== 'play') return;
    s.queue.unshift({ t: 'end-turn' });
    return;
  }
  s.awaiting = { type: 'scramble', seat, from: { r: fr, c: fc }, free: !!free, banish: !!banish, then, options };
};

function banishCell(s, r, c) {
  // a charged draugr spends its spite on the attack; once the charger has
  // scrambled off it, it dissolves — its tile leaves the forest entirely
  const t = tileAt(s, r, c);
  if (t && t.kind === 'draugr') {
    s.discard.push(t);
    s.grid[key(r, c)] = null;
    ev(s, 'banish', { r, c, tile: t });
    log(s, 'Its spite spent, the Draugr dissolves — banished from the forest.', 'good');
  }
}

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
  s.seq = (s.seq || 0) + 1; // action counter: clients animate each action once
  s.events = []; // each action broadcast carries only its own events
  if (!s.turnEvents) s.turnEvents = []; // states persisted before this field existed
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
      else log(s, 'Hope gutters in the stillness — a path tile is lost.', 'info');
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
    fallDoomCheck(s, p);
    if (s.phase !== 'play') return;
    s.queue.unshift({ t: 'end-turn' });
    startHitWave(s, trig, { mover: p.seat, lateral: false });
    return;
  }

  if (kind === 'charge') {
    if (p.resolve < 1) err('No Resolve to go berserk.');
    p.resolve--;
    log(s, `${p.name} rushes the Draugr in a berserk fury!`, 'danger');
    const trig = triggeredBy(s, [originKey, destKey]);
    p.r = nr; p.c = nc;
    ev(s, 'move', { seat: p.seat, from: [or_, oc], to: [nr, nc] });
    if (originFractured) fractureCell(s, or_, oc);
    // the charger always stands in the draugr's sight, so its strike always
    // lands on them; once the attack concludes and they scramble off it,
    // the draugr is banished (banish flag on the scramble)
    s.queue.unshift({ t: 'scramble', seat: p.seat, from: [nr, nc], free: false, banish: true, then });
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
  // in the base game the circle is spent either way: the prompt never comes
  // again (leaving crumbles it, and no one else can enter while they stand)
  if (!s.randomRunes) {
    const circle = tileAt(s, p.r, p.c);
    if (circle && circle.kind === 'rune') circle.spent = true;
  }
  if (payload.skip) {
    log(s, `${p.name} leaves the runes untouched.`, 'info');
    return;
  }
  let pantheon, k;
  if (s.randomRunes) {
    // the stones choose: a random rune not currently borne by any soul
    // (4 souls hold at most 4 of the 8 runes, so the pool is never empty)
    const held = new Set();
    for (const q of s.players) if (q.rune) held.add(q.rune.p + ':' + q.rune.k);
    const pool = [];
    for (const pn of ['valhalla', 'folkvangr']) {
      for (const rn of RUNES[pn]) if (!held.has(pn + ':' + rn.k)) pool.push([pn, rn.k]);
    }
    [pantheon, k] = pool[Math.floor(rand(s) * pool.length)];
  } else {
    ({ p: pantheon, k } = payload);
    const set = RUNES[pantheon];
    if (!set || !set.some(r => r.k === k)) err('No such rune.');
  }
  p.rune = { p: pantheon, k };
  const r = RUNES[pantheon].find(rn => rn.k === k);
  ev(s, 'rune', { seat: p.seat });
  log(s, s.randomRunes
    ? `The stones choose for ${p.name}: ${r.name} ${r.g} (${GATE_NAMES[pantheon]}).`
    : `${p.name} is marked with ${r.name} ${r.g} (${GATE_NAMES[pantheon]}).`, 'good');
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
    log(s, `${p.name} staggers clear.`, 'info');
    if (aw.banish) banishCell(s, aw.from.r, aw.from.c);
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
    if (aw.banish) banishCell(s, aw.from.r, aw.from.c);
    log(s, `${p.name} staggers straight onto another Draugr!`, 'danger');
    // the newly stumbled-onto draugr follows stumble rules: it is not banished
    s.queue.unshift({ t: 'scramble', seat: p.seat, from: [r, c], free: false, then });
    startHitWave(s, [[r, c]], { mover: p.seat, lateral: false });
    return;
  }
  const rots = aw.free
    ? [0, 1, 2, 3]
    : [0, 1, 2, 3].filter(rot => exitsFor(tile.kind, rot)[OPP(opt.d)]);
  s.blindCtx = { scramble: true, then, from: [aw.from.r, aw.from.c], banish: !!aw.banish };
  s.awaiting = { type: 'place-scramble', seat: p.seat, tile, r, c, rots };
};

ACTIONS['place-scramble'] = (s, p, { rot }, aw) => {
  if (!aw.rots.includes(rot)) err('Bad rotation.');
  s.awaiting = null;
  const { then, from, banish } = s.blindCtx;
  s.blindCtx = null;
  setTile(s, aw.r, aw.c, aw.tile, rot);
  ev(s, 'reveal', { r: aw.r, c: aw.c });
  if (from) ev(s, 'move', { seat: p.seat, from, to: [aw.r, aw.c] });
  p.r = aw.r; p.c = aw.c; p.placed = true; p.falling = null;
  if (banish && from) banishCell(s, from[0], from[1]);
  log(s, `${p.name} claws their way onto ${describeTile(aw.tile)}.`, 'info');
  s.queue.unshift({ t: 'arrive', seat: p.seat, then });
};

ACTIONS['post-move'] = (s, p, payload, aw) => {
  if (payload.kind === 'end') {
    s.awaiting = null;
    s.queue.unshift({ t: 'end-turn' });
    return;
  }
  if (payload.kind === 'move') {
    if (!aw.canMoveAgain) err('Cannot press on.');
    const mv = aw.moves.find(m => m.d === payload.d);
    if (!mv) err('Not a legal move.');
    if (p.resolve < 1) err('No Resolve.');
    s.awaiting = null;
    p.resolve--;
    s.movesThisTurn = (s.movesThisTurn || 0) + 1;
    log(s, `${p.name} presses on, spending Resolve for another step.`, 'info');
    doMove(s, p, mv, 'post-move');
    return;
  }
  err('Unknown choice.');
};

ACTIONS['niflheim'] = (s, p, payload, aw) => {
  if (payload.sustain) {
    if (!aw.canSustain || p.resolve < 1) err('Cannot ward the forest.');
    s.awaiting = null;
    p.resolve--;
    log(s, `${p.name} spends Resolve to ward the forest against Niflheim.`, 'good');
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

// an adopted soul takes its new keeper's name, so a mid-game rescue doesn't
// leave the table talking to a departed player's ghost
export function renameSoul(s, seat, rawName) {
  const p = s.players[seat];
  if (!p) return s;
  const old = p.name;
  let name = String(rawName || '').trim().slice(0, 20) || old;
  if (s.players.some(q => q.seat !== seat && q.name === name)) {
    name += ' ' + ['I', 'II', 'III', 'IV'][seat];
  }
  if (name !== old) {
    p.name = name;
    log(s, `The soul of ${old} passes to ${name}.`, 'info');
  }
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
    lastTurn: s.lastTurn || null,
    randomRunes: !!s.randomRunes,
    tileTotals: s.tileTotals || null,
    turnsTaken: s.turnsTaken || 0,
    seq: s.seq || 0,
    lit: [...litSet(s)],
  };
}

// test hooks
export const _test = {
  tileAt, cellAt, setTile, makeTileDef, sweep, run, STEPS,
  triggeredBy, expandChains, occupantsAt,
};

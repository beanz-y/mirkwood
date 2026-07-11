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
export const STATE_VERSION = 3; // v3: rune realignment (dagaz in, thurisaz out — see RUNES note)

export const SIZE = 6;
export const DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]];
export const DIRNAMES = ['north', 'east', 'south', 'west'];
export const OPP = d => (d + 2) % 4;

// Odin's gate bears Odin's rune (Ansuz); Freyja's gate bears the Vanir's
// wealth-rune (Fehu). Isa is retired — ice belongs to Niflheim, not paradise.
// Thurisaz is retired too (2026-07-10): both Norse rune poems read þurs as
// harm to women (Dickins: "anguish/torture of women") — not this game's
// table. Dagaz replaces it: the Anglo-Saxon poem's "glorious light...
// a source of hope and happiness", the daybreak the souls walk toward.
// perk / winterPerk: the Rune Perks host variant (each rune grants its bearer
// a boon; the winter form applies during Niflheim's Embrace). Text here is the
// single source for the picker, soul card and rules screen.
export const RUNES = {
  valhalla: [
    { k: 'dagaz',  g: 'ᛞ', name: 'Dagaz',  gloss: "Day — hope's daybreak",
      perk: 'Dawn returns — you relight free at the start of your turn',
      winterPerk: 'Dawnkeeper — while you stand on a Gate, the cold cannot take tiles touching it' },
    { k: 'eihwaz', g: 'ᛇ', name: 'Eihwaz', gloss: 'Yew — rooted endurance',
      perk: 'Tireless — your first Press On each turn costs no Resolve',
      winterPerk: 'Deathless roots — a fall never dooms you: land on any tile in the rift’s row or column' },
    { k: 'raido',  g: 'ᚱ', name: 'Raido',  gloss: 'Ride — the righteous path',
      perk: 'Wayfarer — once a turn, 1 ◆: turn an adjacent unoccupied path, or stride across a Void Rift',
      winterPerk: 'The last road — the Wayfarer’s road-craft costs nothing' },
    { k: 'ansuz',  g: 'ᚨ', name: 'Ansuz',  gloss: "God — wisdom and Odin's insight",
      perk: 'Raven-counsel — at your turn’s dawn, the next two stack tiles are known',
      winterPerk: 'The refusal — once per Embrace, the party skips one surrender' },
  ],
  folkvangr: [
    { k: 'berkano', g: 'ᛒ', name: 'Berkano', gloss: 'Birch — nurture and protection',
      perk: 'New growth — 1 ◆: the fractured path you leave does not crumble',
      winterPerk: 'Grove shade — the cold can never claim the last tile standing beside you' },
    { k: 'uruz',    g: 'ᚢ', name: 'Uruz',    gloss: 'Aurochs — vitality and growth',
      perk: 'Deep vitality — Resolve cap 3; your ◆ may pay a teammate’s spend',
      winterPerk: 'Winter strength — your Stay steels +2 ◆' },
    { k: 'wunjo',   g: 'ᚹ', name: 'Wunjo',   gloss: 'Joy — harmony and fulfilment',
      perk: 'Shared joy — your Stay steels an adjacent teammate +1 ◆, and theirs steels you',
      winterPerk: 'Heartened — teammates who begin their move beside you take one free extra step' },
    { k: 'fehu',    g: 'ᚠ', name: 'Fehu',    gloss: "Cattle — wealth, Freyja's plenty",
      perk: 'Stocked hearth — your Stay burns nothing; twice a saga, 1 ◆ buys back a just-burned Gate or Rune Circle',
      winterPerk: 'Winter stores — twice per Embrace, spend 1 ◆ to return a tile the cold has just taken' },
  ],
};
export const GATE_NAMES = { valhalla: 'Valhalla', folkvangr: 'Fólkvangr' };

// ---------------------------------------------------------------- rune perks
// Host variant: each rune grants its bearer a boon (RUNES[..].perk), with a
// second form during Niflheim's Embrace (winterPerk). s.perkSet (null = all 8)
// lets the self-play harness ablate perks one at a time for balance work.

function hasPerk(s, q, k) {
  return !!(s.runePerks && q && q.rune && q.rune.k === k
    && (!s.perkSet || s.perkSet.includes(k)));
}
function perkBearer(s, k) {
  for (const q of s.players) if (q.placed && hasPerk(s, q, k)) return q;
  return null;
}
const resolveCap = (s, q) => (hasPerk(s, q, 'uruz') ? 3 : 2);
const wrapAdj = (a, b) => { // wrapped orthogonal distance ≤ 1 (0 = sharing a gate)
  const dr = Math.min(Math.abs(a.r - b.r), SIZE - Math.abs(a.r - b.r));
  const dc = Math.min(Math.abs(a.c - b.c), SIZE - Math.abs(a.c - b.c));
  return dr + dc;
};
// Deep vitality: the Uruz bearer's ◆ may pay for a teammate's spend on their
// turn — any distance on Normal, adjacent-only on Hard (uruzAdjacent)
function uruzLender(s, actor) {
  const b = perkBearer(s, 'uruz');
  if (!b || b.seat === actor.seat || b.resolve < 1 || !actor.placed) return null;
  if (b.lendOk === false) return null; // the bearer has closed their purse
  if (s.uruzAdjacent && wrapAdj(b, actor) !== 1) return null;
  return b;
}

// Deep vitality consent: the Uruz bearer decides whether their ◆ is open to
// the party (physical table: they simply hand the token over — or don't).
// Standing toggle rather than a per-spend prompt: a Brace happens mid-strike,
// and interrupting it with a second player's consent dialog would stall play.
export function setLendConsent(s, seat, on) {
  const p = s.players[seat];
  if (!p) return;
  p.lendOk = !!on;
  log(s, on
    ? `${p.name} opens their purse — the party may draw on their vitality. (ᚢ)`
    : `${p.name} closes their purse — their Resolve is their own. (ᚢ)`, 'info');
}
function lendResolve(s, actor, what) {
  const b = uruzLender(s, actor);
  if (!b) return false;
  b.resolve--;
  log(s, `${b.name}'s deep vitality pays for ${actor.name}'s ${what}. (ᚢ)`, 'good');
  return true;
}

// eight soul colors, tuned to read against the near-black board and against
// each other (the first four are the original seat defaults)
export const PLAYER_COLORS = ['#e8b23c', '#d05e5e', '#4fb8a8', '#a678d8', '#7fa8dc', '#a3b555', '#d9d3c0', '#c97ba4'];
export const PLAYER_COLOR_NAMES = ['Gold', 'Ember', 'Teal', 'Violet', 'Ice', 'Moss', 'Bone', 'Heather'];

// eight Norse sigils a soul may bear as its token, authored in a 24×24 box;
// "CUR" is replaced with the drawing color at render time
export const TOKEN_ICONS = {
  // horned war-helm: curved horns, peaked dome, angular eye slits, nasal + chin guard
  helm: { name: 'Helm', art: '<path d="M8 7.5 C6 5.5 3.5 4 1.8 3.2 C2.2 5.8 3 8.8 4.6 11 C5.8 9.8 6.9 8.8 8 7.5 Z M16 7.5 C18 5.5 20.5 4 22.2 3.2 C21.8 5.8 21 8.8 19.4 11 C18.2 9.8 17.1 8.8 16 7.5 Z" fill="CUR"/><path fill-rule="evenodd" d="M12 2.8 C7.8 2.8 5.3 5.8 5 10 C4.8 13 5 16 5.9 19 C6.5 21.2 7.6 22.8 8.9 23.4 L10.2 19.6 L12 22.2 L13.8 19.6 L15.1 23.4 C16.4 22.8 17.5 21.2 18.1 19 C19 16 19.2 13 19 10 C18.7 5.8 16.2 2.8 12 2.8 Z M6.6 12.8 L10.1 14.4 L9.3 16.1 L6.3 15 Z M17.4 12.8 L13.9 14.4 L14.7 16.1 L17.7 15 Z" fill="CUR"/>' },
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
  // triquetra: three interlocked arcs (trinity knot)
  triquetra: { name: 'Triquetra', art: '<g fill="none" stroke="CUR" stroke-width="2" stroke-linejoin="round"><path d="M12 14.2 C7.7 11 7.7 6.2 12 4 C16.3 6.2 16.3 11 12 14.2 Z"/><path d="M12 14.2 C7.7 11 7.7 6.2 12 4 C16.3 6.2 16.3 11 12 14.2 Z" transform="rotate(120 12 12)"/><path d="M12 14.2 C7.7 11 7.7 6.2 12 4 C16.3 6.2 16.3 11 12 14.2 Z" transform="rotate(240 12 12)"/></g>' },
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
  normal: { straight: 12, tee: 32, teeFractured: 2, cross: 16, rune: 6, draugr: 10, gateValhalla: 1, gateFolkvangr: 1 },
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
// Gate doorway variants (balance experiments; 'one' is the live rule):
// one = the classic single doorway, straight = two opposite doorways,
// tee = three doorways. Selected per game via createGame({ gateExits }),
// carried on state so persisted games and mixed rooms are unaffected.
export const GATE_EXIT_STYLES = {
  one:      [1, 0, 0, 0],
  straight: [1, 0, 1, 0],
  tee:      [1, 1, 0, 1],
};
const BASE_EXITS = {
  start:    [1, 1, 0, 0],
  straight: [1, 0, 1, 0],
  tee:      [1, 1, 0, 1],
  cross:    [1, 1, 1, 1],
  rune:     [1, 1, 1, 1],
  gate:     [1, 0, 0, 0],
  draugr:   [1, 1, 1, 1],
};

export function exitsFor(kind, rot, gateExits) {
  // gateExits (optional) picks the gate-doorway variant; omitted = 'one',
  // so every existing caller keeps the live single-doorway geometry
  const base = kind === 'gate'
    ? (GATE_EXIT_STYLES[gateExits] || GATE_EXIT_STYLES.one)
    : BASE_EXITS[kind];
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
    // gate-doorway variant (balance experiments): 'one' (live rule, default) |
    // 'straight' | 'tee'. Old persisted states lack the field → 'one'.
    gateExits: GATE_EXIT_STYLES[opts.gateExits] ? opts.gateExits : 'one',
    // Rune Perks host variant (see the RUNES table + helpers above)
    runePerks: !!opts.runePerks,
    uruzAdjacent: !!opts.uruzAdjacent, // Hard telling: Uruz lends to neighbors only
    perkSet: Array.isArray(opts.perkSet) ? opts.perkSet : null,
    perkUse: { refusal: false, stores: 0, hearth: 0 }, // limited-use bookkeeping
    freeSteps: 0, // free Press Ons this turn (Eihwaz; +Wunjo's Heartened in winter)
    wayfarerUsed: false, // Raido's road-craft (turn a path / cross a rift), once a turn
    peekLen: null,       // stack length when the Ansuz bearer's turn began (peek snapshot)
    hearthPending: null, // Gate/Rune tiles of the current burn batch, for Fehu's ransom
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
  s.grid[key(r, c)] = { tile: { ...def, rot, exits: exitsFor(def.kind, rot, s.gateExits) } };
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
  const tiles = []; // what the mist takes — public info (the discard is open)
  for (let i = 0; i < n && s.stack.length; i++) {
    const t = s.stack.pop();
    s.discard.push(t);
    burned++;
    tiles.push({ kind: t.kind, gate: t.gate });
    hearthNote(s, t);
    if (t.kind === 'gate') log(s, `The Gate of ${GATE_NAMES[t.gate]} is lost to the mist!`, 'danger');
    else if (t.kind === 'rune') log(s, 'A Rune Circle is lost from the path stack.', 'danger');
  }
  if (burned) ev(s, 'burn', { n: burned, tiles });
}

// Stocked hearth (Fehu): note each treasure the current burn batch takes from
// the stack — the bearer may ransom ONE of them back before the loss is final
function hearthNote(s, t) {
  if (!s.runePerks || (t.kind !== 'gate' && t.kind !== 'rune')) return;
  if (!s.hearthPending) s.hearthPending = [];
  s.hearthPending.push({ id: t.id, kind: t.kind, gate: t.gate || undefined });
}

// offer the ransom (if it applies) and return true if a prompt now waits;
// callers queue their own continuation step before calling
function maybeHearth(s) {
  const pend = s.hearthPending;
  s.hearthPending = null;
  if (!pend || !pend.length || s.phase !== 'play') return false;
  const f = perkBearer(s, 'fehu');
  if (!f || f.resolve < 1) return false;
  if (((s.perkUse && s.perkUse.hearth) || 0) >= 2) return false;
  s.awaiting = { type: 'stocked-hearth', seat: f.seat, options: pend };
  return true;
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

// a fractured tile crumbles when its occupant departs — unless the departing
// soul bears Berkano (New growth) and CHOOSES to spend 1 ◆ holding it (the
// hold intent rides the move payload; the birch's strength is not free).
// The held tile stays fractured for those who follow.
function crumbleBehind(s, p, r, c, fractured, hold) {
  if (!fractured) return;
  if (hold && hasPerk(s, p, 'berkano') && p.resolve >= 1) {
    p.resolve--;
    log(s, `${p.name} spends Resolve — the birch holds the cracked path together. (ᛒ)`, 'good');
    return;
  }
  fractureCell(s, r, c);
}

// New growth (Berkano): may the mover pay 1 ◆ to hold the fractured tile
// they stand on as they leave it? (surfaced on the action/post-move awaiting
// so the client knows to ask; the intent itself rides the move payload)
function canHoldPath(s, p) {
  if (!p.placed || !hasPerk(s, p, 'berkano') || p.resolve < 1) return false;
  const t = tileAt(s, p.r, p.c);
  return !!(t && t.fractured);
}

// Wayfarer (Raido): tiles the bearer may turn — orthogonally beside them
// (no open passage required: turning is how a blocked mouth gets fixed),
// standing, unoccupied, and of a kind whose exits rotation can change.
// Gates are monuments and Draugr are not road; cross/rune tiles open every
// way already. 1 ◆ (free in the Embrace), once a turn, shared with the
// rift-crossing.
const TURNABLE = { straight: 1, tee: 1, start: 1 };
function turnTargets(s, p) {
  const out = [];
  if (!p.placed || !hasPerk(s, p, 'raido') || s.wayfarerUsed) return out;
  if (p.resolve < (s.niflheim ? 0 : 1)) return out;
  for (let d = 0; d < 4; d++) {
    const [nr, nc] = stepDir(p.r, p.c, d);
    const t = tileAt(s, nr, nc);
    if (!t || !TURNABLE[t.kind]) continue;
    if (occupantsAt(s, nr, nc).length) continue;
    out.push({ r: nr, c: nc });
  }
  return out;
}

function doTurnTile(s, p, payload, then) {
  // validate fully BEFORE consuming the prompt — a bad pick must not wedge
  if (!hasPerk(s, p, 'raido')) err('Only the Wayfarer may turn the road.');
  if (s.wayfarerUsed) err('The road has already answered this turn.');
  validCell(payload.r, payload.c); validRot(payload.rot);
  if (!turnTargets(s, p).some(o => o.r === payload.r && o.c === payload.c)) err('That path cannot be turned.');
  const t = tileAt(s, payload.r, payload.c);
  const newExits = exitsFor(t.kind, payload.rot, s.gateExits);
  if (newExits.every((v, i) => v === t.exits[i])) err('It already lies so.');
  const cost = s.niflheim ? 0 : 1;
  if (p.resolve < cost) err('No Resolve.');
  s.awaiting = null;
  p.resolve -= cost;
  s.wayfarerUsed = true;
  t.rot = payload.rot;
  t.exits = newExits;
  ev(s, 'turn', { r: payload.r, c: payload.c, rot: payload.rot });
  log(s, `${p.name} turns the path to suit the road${cost ? ', spending Resolve' : ''}. (ᚱ)`, 'good');
  // connectivity just changed by hand: in the Embrace a severed road can
  // decide the saga at once (the network never heals once the stack is spent)
  if (s.niflheim) lossCheck(s);
  if (s.phase !== 'play') return;
  s.queue.unshift({ t: then });
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
    if (cl && cl.rift) {
      moves.push({ d, kind: 'jump', r: nr, c: nc });
      // Wayfarer (Raido): step ACROSS the rift to solid ground beyond —
      // 1 ◆ normally, free once the Embrace holds (The last road). The
      // road-craft answers once a turn, shared with turning a path.
      const cost = s.niflheim ? 0 : 1;
      if (hasPerk(s, p, 'raido') && !s.wayfarerUsed && p.resolve >= cost) {
        const [rr, cc] = stepDir(nr, nc, d);
        const ft = tileAt(s, rr, cc);
        if (ft && ft.exits[OPP(d)] && ft.kind !== 'draugr'
          && (ft.kind === 'gate' || !occupantsAt(s, rr, cc).length)) {
          moves.push({ d, kind: 'cross', r: rr, c: cc, cost });
        }
      }
      continue;
    }
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
  const rekindle = !p.hopeful && (p.resolve > 0 || !!uruzLender(s, p));
  return { moves, stay, rekindle, turns: turnTargets(s, p), canHold: canHoldPath(s, p) };
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
  // Deathless roots (Eihwaz): with nothing left to draw, the bearer still
  // lands on any standing tile in the rift's row or column — no doom while
  // one remains for them to cling to
  if (hasPerk(s, p, 'eihwaz')) {
    const { r: fr, c: fc } = p.falling;
    for (let i = 0; i < SIZE; i++) {
      if ((tileAt(s, fr, i) && !occupantsAt(s, fr, i).length)
        || (tileAt(s, i, fc) && !occupantsAt(s, i, fc).length)) return;
    }
  }
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
  let needed = Infinity, bestGate = null;
  for (const g of new Set(gates)) {
    const held = new Set();
    for (const p of s.players) {
      if (p.rune && p.rune.p === g) held.add(p.rune.k);
    }
    const need = 4 - held.size;
    if (need < needed) { needed = need; bestGate = g; }
  }
  if (circles < needed) {
    // Distinguish the trigger. If souls bear marks for a gate that is no longer
    // available (it burned out from under them), the true cause is that GATE's
    // loss — their marks turn worthless and too few circles remain to swear anew.
    // Otherwise it is a plain shortage of Rune Circles. (Don't conflate the two —
    // a playtester lost their standing Fólkvangr-marked party when the Fólkvangr
    // gate burned, and the message blamed the circles, not the gate.)
    const orphaned = [...new Set(
      s.players.filter(p => p.rune && !gates.includes(p.rune.p)).map(p => p.rune.p)
    )];
    if (orphaned.length) {
      const lost = orphaned.map(g => `The Gate of ${GATE_NAMES[g]}`).join(' and ');
      lose(s, `${lost} is lost to the mist — the marks the souls bore for it turn to ash, and with too few Rune Circles left they can never swear the ${needed} the Gate of ${GATE_NAMES[bestGate]} still demands.`);
    } else {
      lose(s, 'Too many Rune Circles are lost to the mist — the souls can never bear the four marks a gate demands.');
    }
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
    rots: [0, 1, 2, 3].filter(rot => exitsFor(tile.kind, rot, s.gateExits)[OPP(tg.d)]),
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
  // free Press Ons this turn: Eihwaz's tirelessness, and — in the Embrace —
  // Wunjo's Heartened (beginning your move beside the bearer, or on their gate)
  s.freeSteps = 0;
  if (hasPerk(s, p, 'eihwaz')) s.freeSteps++;
  // Wayfarer (Raido): the road answers once each turn
  s.wayfarerUsed = false;
  // Raven-counsel (Ansuz): the ravens report at the turn's dawn — a single
  // physical peek at the top of the stack, not a running watch. publicState
  // shows the snapshot's tiles until they are drawn.
  s.peekLen = hasPerk(s, p, 'ansuz') ? s.stack.length : null;
  s.hearthPending = null; // any unclaimed ransom window has closed
  if (s.niflheim) {
    const w = perkBearer(s, 'wunjo');
    if (w && w.seat !== p.seat && p.placed && wrapAdj(w, p) <= 1) {
      s.freeSteps++;
      log(s, `${w.name}'s joy heartens ${p.name} for the road. (ᚹ)`, 'good');
    }
  }
  log(s, `— ${p.name}'s turn —`, 'turn');
  if (p.falling) { STEPS['landing'](s); return; }
  // Dawn returns: the Dagaz bearer never begins a turn hopeless
  if (!p.hopeful && p.placed && hasPerk(s, p, 'dagaz')) {
    p.hopeful = true;
    ev(s, 'rekindle', { seat: p.seat });
    log(s, `Dawn returns — ${p.name}'s ember rekindles itself. (ᛞ)`, 'good');
    s.queue.unshift({ t: 'illum', forSeat: p.seat, chooser: p.seat }, { t: 'relight', chooser: s.turn }, { t: 'action' });
    return;
  }
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
  // Deathless roots (Eihwaz): with the stack spent, the bearer ignores the
  // empty spaces (nothing can be drawn to land on) and clings to a standing
  // tile in the row or column instead
  const rooted = !s.stack.length && hasPerk(s, p, 'eihwaz');
  if (rooted && empty.length) log(s, `${p.name} clings to the deathless roots. (ᛇ)`, 'good');
  if (empty.length && !rooted) {
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
        gates: [...new Set(gatesLeft(s))], // only these pantheons' runes can still open a way
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
  // Stocked hearth (Fehu): a treasure burned by the strikes may be ransomed
  // back BEFORE the loss check — the rescue must be able to avert the doom
  if (maybeHearth(s)) { s.queue.unshift({ t: 'loss-check' }); return; }
  lossCheck(s);
};

STEPS['loss-check'] = (s) => { lossCheck(s); };

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
      gates: [...new Set(gatesLeft(s))], // only these pantheons' runes can still open a way
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
  const canMoveAgain = (p.resolve > 0 || s.freeSteps > 0 || !!uruzLender(s, p))
    && s.movesThisTurn < 3 && moves.length > 0;
  s.awaiting = {
    type: 'post-move', seat: s.turn, canMoveAgain, moves, freeStep: s.freeSteps > 0,
    turns: turnTargets(s, p), canHold: canHoldPath(s, p),
  };
};

STEPS['end-turn'] = (s) => {
  if (s.phase !== 'play') return;
  if (!s.stack.length && !s.niflheim) {
    s.niflheim = true;
    log(s, 'The path stack is spent — the last ember of shared hope goes dark. NIFLHEIM’S EMBRACE begins.', 'danger');
  }
  if (s.niflheim) {
    let removable = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      const cl = cellAt(s, r, c);
      // the Embrace may surrender ANY tile it still sees — Gates and Void Rifts
      // included (playtest ruling: a tile is on the board until it is unlit) —
      // sparing only one a soul is standing on.
      if (cl && (cl.tile || cl.rift) && !occupantsAt(s, r, c).length) removable.push({ r, c });
    }
    // Dawnkeeper (Dagaz): while the bearer holds a Gate, the cold CANNOT take
    // the tiles touching it — hard protection, even if nothing else remains
    const dawn = perkBearer(s, 'dagaz');
    if (dawn && removable.length) {
      const dt = tileAt(s, dawn.r, dawn.c);
      if (dt && dt.kind === 'gate') {
        removable = removable.filter(o => wrapAdj(dawn, { r: o.r, c: o.c }) !== 1);
        if (!removable.length) log(s, `The dawn holds at the gate — the cold finds nothing to take. (ᛞ)`, 'good');
      }
    }
    // Grove shade (Berkano): one tile beside the bearer is protected as if a
    // soul stood on it. Since the party chooses its own surrenders, the choice
    // only BINDS when the cold's last option is a single tile at her side —
    // that one can never be taken. (No filtering otherwise: the party stays
    // free to give up whichever tile it judges least dear.)
    const birch = perkBearer(s, 'berkano');
    if (birch && removable.length === 1
      && wrapAdj(birch, { r: removable[0].r, c: removable[0].c }) === 1) {
      log(s, `The grove's shade holds the last path beside ${birch.name} — the cold is denied. (ᛒ)`, 'good');
      removable = [];
    }
    if (removable.length) {
      const p = P(s, s.turn);
      s.queue.unshift({ t: 'end-turn2' });
      s.awaiting = {
        type: 'niflheim', seat: s.turn,
        canSustain: p.resolve > 0 || !!uruzLender(s, p),
        canRefuse: !s.perkUse.refusal && !!perkBearer(s, 'ansuz'),
        options: removable,
      };
      return;
    }
  }
  STEPS['end-turn2'](s);
};

STEPS['end-turn2'] = (s) => {
  // Stocked hearth (Fehu): a treasure burned this turn (a Stay's stillness)
  // may be ransomed back before the loss check; maybeHearth clears the
  // pending batch, so the re-entry below cannot loop
  if (maybeHearth(s)) { s.queue.unshift({ t: 'end-turn2' }); return; }
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
    if (p.resolve < 1 && !uruzLender(s, p)) err('No Resolve.');
    s.awaiting = null;
    if (p.resolve >= 1) p.resolve--;
    else lendResolve(s, p, 'rekindling');
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
    const mv = aw.moves.find(m => m.d === payload.d && (payload.cross ? m.kind === 'cross' : m.kind !== 'cross'));
    if (!mv) err('Not a legal move.');
    if (payload.hold) {
      // the hold's 1 ◆ comes AFTER the move's own tolls (rift toll, berserk):
      // demand the whole purse up front so the hold can't silently fail
      const ownCost = 1 + (mv.cost || 0) + (mv.kind === 'charge' ? 1 : 0);
      if (!canHoldPath(s, p) || p.resolve < ownCost) err('Not enough Resolve to hold the path as well.');
    }
    s.awaiting = null;
    s.movesThisTurn = (s.movesThisTurn || 0) + 1;
    doMove(s, p, mv, 'post-move', !!payload.hold);
    return;
  }
  if (kind === 'turn') {
    // Wayfarer (Raido): turn an adjacent path, then choose the turn's action
    // afresh — the roads (and so the legal moves) have changed
    doTurnTile(s, p, payload, 'action');
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
    const gain = (s.niflheim && hasPerk(s, p, 'uruz')) ? 2 : 1; // Winter strength
    p.resolve = Math.min(resolveCap(s, p), p.resolve + gain);
    log(s, `${p.name} stands fast and steels their Resolve (+${gain}).`, 'info');
    // Shared joy flows both ways: a teammate's Stay beside the Wunjo bearer
    // gladdens the bearer too (+1) — joy shared is joy returned
    const w = perkBearer(s, 'wunjo');
    if (w && w.seat !== p.seat && wrapAdj(w, p) <= 1 && w.resolve < resolveCap(s, w)) {
      w.resolve++;
      log(s, `${p.name}'s steadfastness gladdens ${w.name} (+1). (ᚹ)`, 'good');
    }
    // Shared joy: the Wunjo bearer's Stay also steels one adjacent teammate —
    // the bearer CHOOSES when more than one stands near (physical table: they
    // simply say who; digitally a prompt, skipped in the common 0/1 cases)
    if (hasPerk(s, p, 'wunjo')) {
      const near = s.players
        .filter(q => q.placed && q.seat !== p.seat && wrapAdj(q, p) <= 1 && q.resolve < resolveCap(s, q))
        .sort((a, b) => a.resolve - b.resolve);
      if (near.length === 1) {
        near[0].resolve++;
        log(s, `${p.name}'s joy steels ${near[0].name} (+1). (ᚹ)`, 'good');
      } else if (near.length > 1) {
        s.queue.unshift({ t: 'stay-burn' });
        s.awaiting = {
          type: 'shared-joy', seat: p.seat,
          options: near.map(q => ({ seat: q.seat, name: q.name, resolve: q.resolve })),
        };
        return;
      }
    }
  } else {
    log(s, `${p.name} is trapped, hopeless and unmoving.`, 'info');
  }
  s.queue.unshift({ t: 'stay-burn' });
}

// the Stay's cost, split out so a perk prompt (Shared joy) may come first:
// burn the top tile (unless Freyja's hearth is stocked), then check the
// ground underfoot
STEPS['stay-burn'] = (s) => {
  const p = P(s, s.turn);
  // staying burns hope — unless Freyja's hearth is stocked (Fehu). Lingering
  // at a Rune Circle under Random Runes always burns: no free rerolls.
  const hearthT = tileAt(s, p.r, p.c);
  const lingering = s.randomRunes && hearthT && hearthT.kind === 'rune';
  if (hasPerk(s, p, 'fehu') && !lingering && s.stack.length) {
    log(s, `${p.name}'s hearth is stocked — the forest keeps its hope. (ᚠ)`, 'good');
  } else if (s.stack.length) {
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
      ev(s, 'burn', { n: 1, tiles: [{ kind: t.kind, gate: t.gate }] });
      log(s, 'A Draugr stirs in the mist, finds no path, and sinks away.', 'info');
    } else {
      s.discard.push(t);
      ev(s, 'burn', { n: 1, tiles: [{ kind: t.kind, gate: t.gate }] });
      hearthNote(s, t);
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

function doMove(s, p, mv, then, hold) {
  const { d, kind } = mv;
  const [or_, oc] = [p.r, p.c];
  const originKey = key(or_, oc);
  const [nr, nc] = [mv.r, mv.c];
  const destKey = key(nr, nc);
  const originTile = tileAt(s, or_, oc);
  const originFractured = originTile && originTile.fractured;

  if (kind === 'cross') {
    // Wayfarer (Raido): pay the toll and stride the gap; the rift remains.
    // Falls through to the ordinary arrival below — mv.r/mv.c is the far side.
    if (mv.cost) p.resolve -= mv.cost;
    s.wayfarerUsed = true; // the road answers once a turn
    log(s, `${p.name} strides across the Void Rift${mv.cost ? ', spending Resolve' : ''}. (ᚱ)`, 'good');
  }

  if (kind === 'jump') {
    log(s, `${p.name} leaps into the Void Rift.`, 'info');
    const trig = triggeredBy(s, [originKey]);
    ev(s, 'fall', { seat: p.seat, from: [or_, oc], r: nr, c: nc });
    crumbleBehind(s, p, or_, oc, originFractured, hold);
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
    crumbleBehind(s, p, or_, oc, originFractured, hold);
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
      crumbleBehind(s, p, or_, oc, originFractured, hold);
      s.queue.unshift({ t: 'scramble', seat: p.seat, from: [nr, nc], free: false, then });
      startHitWave(s, trig, { mover: p.seat, lateral: false });
      return;
    }
    const rots = [0, 1, 2, 3].filter(rot => exitsFor(tile.kind, rot, s.gateExits)[OPP(d)]);
    s.blindCtx = { origin: [or_, oc], d, then, originFractured, hold: !!hold };
    s.awaiting = { type: 'place-blind', seat: p.seat, tile, r: nr, c: nc, rots };
    return;
  }

  // normal move (incl. onto gates)
  log(s, `${p.name} moves ${DIRNAMES[d]}.`, 'info');
  const trig = triggeredBy(s, [originKey, destKey]);
  p.r = nr; p.c = nc;
  ev(s, 'move', { seat: p.seat, from: [or_, oc], to: [nr, nc] });
  crumbleBehind(s, p, or_, oc, originFractured, hold);
  s.queue.unshift({ t: 'arrive', seat: p.seat, then });
  startHitWave(s, trig, { mover: p.seat, lateral: true });
}

ACTIONS['place-blind'] = (s, p, { rot }, aw) => {
  if (!aw.rots.includes(rot)) err('That rotation does not connect.');
  s.awaiting = null;
  const { origin, then, originFractured, hold } = s.blindCtx;
  s.blindCtx = null;
  setTile(s, aw.r, aw.c, aw.tile, rot);
  const originKey = key(origin[0], origin[1]);
  const destKey = key(aw.r, aw.c);
  const trig = triggeredBy(s, [originKey, destKey]);
  p.r = aw.r; p.c = aw.c;
  ev(s, 'reveal', { r: aw.r, c: aw.c });
  ev(s, 'move', { seat: p.seat, from: origin, to: [aw.r, aw.c] });
  crumbleBehind(s, p, origin[0], origin[1], originFractured, hold);
  log(s, `${p.name} feels their way onto ${describeTile(aw.tile)}.`, 'info');
  s.queue.unshift({ t: 'arrive', seat: p.seat, then });
  startHitWave(s, trig, { mover: p.seat, lateral: true });
};

ACTIONS['block'] = (s, p, { block }) => {
  if (block && p.resolve < 1 && !uruzLender(s, p)) err('No Resolve to brace with.');
  const { seat } = s.pendingHit;
  s.pendingHit = null;
  s.awaiting = null;
  if (block) {
    if (p.resolve >= 1) p.resolve--;
    else lendResolve(s, p, 'brace');
    applyHit(s, seat, 2, true);
  } else {
    applyHit(s, seat, 3, false);
  }
};

ACTIONS['attune'] = (s, p, payload) => {
  // validate BEFORE consuming the prompt — a refused pick must leave the
  // decision open and the circle unspent, not wedge the game
  if (!s.randomRunes && !payload.skip) {
    const set = RUNES[payload.p];
    if (!set || !set.some(r => r.k === payload.k)) err('No such rune.');
    // a rune only opens a gate that can still be reached: once a pantheon's
    // gate is wholly lost (burned from the stack with none on the board), its
    // marks are ash — the stones no longer offer them (playtest rule: players
    // missed the gate's burning and swore to it anyway)
    if (!gatesLeft(s).includes(payload.p)) {
      err(`The Gate of ${GATE_NAMES[payload.p]} is lost to the mist — its runes hold no power now.`);
    }
  }
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
    // the stones choose: a random rune of an ATTAINABLE gate not currently
    // borne by any soul
    const attainable = new Set(gatesLeft(s));
    const held = new Set();
    for (const q of s.players) if (q.rune) held.add(q.rune.p + ':' + q.rune.k);
    const pool = [];
    for (const pn of ['valhalla', 'folkvangr']) {
      if (!attainable.has(pn)) continue;
      for (const rn of RUNES[pn]) if (!held.has(pn + ':' + rn.k)) pool.push([pn, rn.k]);
    }
    if (!pool.length) {
      // possible once a gate is lost: the surviving gate's four runes may all
      // be borne already — the stones have nothing left worth giving
      log(s, `The stones are silent — no rune remains that ${p.name} could bear.`, 'info');
      return;
    }
    [pantheon, k] = pool[Math.floor(rand(s) * pool.length)];
  } else {
    ({ p: pantheon, k } = payload);
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
  p.hopeful = true; // the ember survives the fall — land lit and kindle anew (TNC-faithful)
  ev(s, 'land', { seat: p.seat, r, c });
  log(s, `${p.name} falls back into Myrkviðr, ember still glowing.`, 'info');
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
    : [0, 1, 2, 3].filter(rot => exitsFor(tile.kind, rot, s.gateExits)[OPP(opt.d)]);
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
  if (payload.kind === 'turn') {
    // Wayfarer (Raido): the road may still be turned between steps
    doTurnTile(s, p, payload, 'post-move');
    return;
  }
  if (payload.kind === 'move') {
    if (!aw.canMoveAgain) err('Cannot press on.');
    const mv = aw.moves.find(m => m.d === payload.d && (payload.cross ? m.kind === 'cross' : m.kind !== 'cross'));
    if (!mv) err('Not a legal move.');
    const free = s.freeSteps > 0;
    if (payload.hold) {
      // press-on (when not free), rift toll and berserk all draw from the
      // bearer's own purse before the hold's 1 ◆ — demand the total up front
      const ownCost = 1 + (free ? 0 : 1) + (mv.cost || 0) + (mv.kind === 'charge' ? 1 : 0);
      if (!canHoldPath(s, p) || p.resolve < ownCost) err('Not enough Resolve to hold the path as well.');
    }
    if (!free && p.resolve < 1 && !uruzLender(s, p)) err('No Resolve.');
    s.awaiting = null;
    if (free) {
      s.freeSteps--;
      log(s, `${p.name} presses on, tireless.`, 'info');
    } else if (p.resolve >= 1) {
      p.resolve--;
      log(s, `${p.name} presses on, spending Resolve for another step.`, 'info');
    } else {
      lendResolve(s, p, 'stride'); // verified above
      log(s, `${p.name} presses on.`, 'info');
    }
    s.movesThisTurn = (s.movesThisTurn || 0) + 1;
    doMove(s, p, mv, 'post-move', !!payload.hold);
    return;
  }
  err('Unknown choice.');
};

ACTIONS['niflheim'] = (s, p, payload, aw) => {
  if (payload.refuse) {
    // The refusal (Ansuz, once per Embrace): the party denies the cold its toll
    if (!aw.canRefuse) err('The refusal has been spoken already.');
    s.awaiting = null;
    s.perkUse.refusal = true;
    const b = perkBearer(s, 'ansuz');
    log(s, `${b ? b.name : 'The party'} speaks the Allfather's refusal — the cold is denied its toll. (ᚨ)`, 'good');
    return;
  }
  if (payload.sustain) {
    if (!aw.canSustain || (p.resolve < 1 && !uruzLender(s, p))) err('Cannot ward the forest.');
    s.awaiting = null;
    if (p.resolve >= 1) {
      p.resolve--;
      log(s, `${p.name} spends Resolve to ward the forest against Niflheim.`, 'good');
    } else {
      lendResolve(s, p, 'ward');
    }
    return;
  }
  const opt = aw.options.find(o => o.r === payload.r && o.c === payload.c);
  if (!opt) err('Cannot remove that tile.');
  s.awaiting = null;
  const cl = cellAt(s, payload.r, payload.c);
  const t = cl && cl.tile; // a Void Rift cell has no tile
  s.grid[key(payload.r, payload.c)] = null;
  if (t) {
    s.discard.push(t);
    ev(s, 'sweep', { cells: [{ r: payload.r, c: payload.c, tile: t, rift: false }] });
    log(s, `Niflheim's cold claims ${describeTile(t)}.`, 'danger');
    // Winter stores (Fehu): the bearer may buy the taken tile back at once
    const f = perkBearer(s, 'fehu');
    if (f && s.perkUse.stores < 2 && f.resolve >= 1) {
      s.storesCtx = { r: payload.r, c: payload.c };
      s.awaiting = { type: 'winter-stores', seat: f.seat, r: payload.r, c: payload.c, tile: { kind: t.kind, gate: t.gate } };
    }
  } else {
    ev(s, 'sweep', { cells: [{ r: payload.r, c: payload.c, tile: null, rift: true }] });
    log(s, `Niflheim's cold swallows a Void Rift.`, 'danger');
  }
};

ACTIONS['shared-joy'] = (s, p, payload, aw) => {
  // the Wunjo bearer names which neighbor their Stay steels
  const opt = aw.options.find(o => o.seat === (payload.seat | 0));
  if (!opt) err('They stand too far from the fire.');
  s.awaiting = null;
  const q = s.players[opt.seat];
  q.resolve = Math.min(resolveCap(s, q), q.resolve + 1);
  log(s, `${p.name}'s joy steels ${q.name} (+1). (ᚹ)`, 'good');
};

ACTIONS['winter-stores'] = (s, p, payload) => {
  // validate BEFORE consuming the prompt — a refused restore must not wedge.
  // As with the hearth-ransom, declining must be explicit (restore:false):
  // a stray racing payload bounces instead of silently letting the tile go
  if (payload.restore) {
    if (!s.storesCtx) err('Nothing to restore.');
    if (p.resolve < 1 || s.perkUse.stores >= 2) err('The stores are spent.');
  } else if (payload.restore !== false && !payload.decline) {
    err('The stores await an answer.');
  }
  const ctx = s.storesCtx;
  s.awaiting = null;
  s.storesCtx = null;
  if (!payload.restore) return; // let it go — the cold keeps its prize
  p.resolve--;
  s.perkUse.stores++;
  const t = s.discard.pop(); // the tile the cold just claimed
  s.grid[key(ctx.r, ctx.c)] = { tile: t };
  ev(s, 'reveal', { r: ctx.r, c: ctx.c });
  log(s, `${p.name} opens Freyja's stores — ${describeTile(t)} is returned to the forest. (ᚠ)`, 'good');
};

ACTIONS['stocked-hearth'] = (s, p, payload, aw) => {
  // validate BEFORE consuming the prompt — a refused ransom must not wedge.
  // The decline must be EXPLICIT: this prompt can avert a loss, so a stray
  // payload racing in from a click meant for the previous decision must
  // bounce (err leaves the prompt open), never silently wave the treasure off
  let di = -1;
  if (payload.restore) {
    const opt = aw.options.find(o => o.id === payload.id);
    if (!opt) err('That treasure was not just burned.');
    if (p.resolve < 1 || ((s.perkUse && s.perkUse.hearth) || 0) >= 2) err('The hearth is spent.');
    for (let i = s.discard.length - 1; i >= 0; i--) {
      if (s.discard[i].id === payload.id) { di = i; break; }
    }
    if (di < 0) err('The mist keeps it.');
  } else if (!payload.decline) {
    err('The hearth awaits an answer — ransom the tile, or let the cold keep it.');
  }
  s.awaiting = null;
  if (!payload.restore) {
    log(s, `${p.name} lets the cold keep its prize.`, 'info');
    return; // continuation is queued
  }
  const t = s.discard.splice(di, 1)[0];
  p.resolve--;
  if (!s.perkUse) s.perkUse = { refusal: false, stores: 0, hearth: 0 };
  s.perkUse.hearth = (s.perkUse.hearth || 0) + 1;
  // shuffled back among the paths — the party may not steer WHERE it returns
  const idx = Math.floor(rand(s) * (s.stack.length + 1));
  s.stack.splice(idx, 0, t);
  // the pile has been disturbed: the raven's dawn report no longer holds
  if (s.peekLen != null) s.peekLen = s.stack.length + 2;
  ev(s, 'ransom', { tile: { kind: t.kind, gate: t.gate || undefined } });
  log(s, `${p.name} opens the stocked hearth — ${describeTile(t)} is ransomed from the mist and shuffled back among the paths. (ᚠ)`, 'good');
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

// Raven-counsel snapshot: how much of the turn-dawn peek is still ahead of the
// stack top. s.peekLen is the stack length when the bearer's turn began; each
// draw consumes one known tile, and a hearth-ransom reshuffle voids the rest.
// Old persisted states (no peekLen) show the top two until the next turn dawn.
function stackPeekView(s) {
  if (!(s.runePerks && s.phase === 'play' && s.players[s.turn] && hasPerk(s, s.players[s.turn], 'ansuz'))) return null;
  const snapLen = (s.peekLen == null) ? s.stack.length : s.peekLen;
  const known = Math.max(0, Math.min(2 - (snapLen - s.stack.length), 2));
  if (!known) return null;
  return s.stack.slice(-known).reverse().map(t => ({ kind: t.kind, gate: t.gate || undefined }));
}

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
    gateExits: s.gateExits || 'one',
    runePerks: !!s.runePerks,
    uruzAdjacent: !!s.uruzAdjacent,
    perkUse: s.perkUse || null,
    // Raven-counsel (Ansuz): the ravens report ONCE at the bearer's turn dawn —
    // surfaced to the whole table, exactly as a physical peek-and-tell would be.
    // Tiles drawn since the snapshot are spent knowledge; the peek never slides
    // forward to newer tiles (that would out-see a real table's single look).
    stackPeek: stackPeekView(s),
    tileTotals: s.tileTotals || null,
    turnsTaken: s.turnsTaken || 0,
    seq: s.seq || 0,
    lit: [...litSet(s)],
  };
}

// test hooks
export const _test = {
  tileAt, cellAt, setTile, makeTileDef, sweep, run, STEPS,
  triggeredBy, expandChains, occupantsAt, lossCheck,
};

/*
 * Mirkwood self-play policy (v2 — cooperative). Extracted so debug tools and
 * future tuning sessions can import it. See tools/selfplay.js for the runner
 * and the strategic commentary; refine THIS file to make the party smarter.
 */
import {
  losFor, litSet, RUNES, SIZE, key, OPP, exitsFor, stepDir, applyAction,
} from '../public/shared/engine.js';

const wrapDist = (r1, c1, r2, c2) =>
  Math.min(Math.abs(r1 - r2), SIZE - Math.abs(r1 - r2))
  + Math.min(Math.abs(c1 - c2), SIZE - Math.abs(c1 - c2));

// ---------------------------------------------------------------- tunable weights
//
// The hand-tuned magic numbers that drive movement, lifted into one object so the
// CEM tuner (tools/tune.js) can search over them. Defaults ARE the original
// literals, so `policy(s, rnd, {})` is byte-for-byte the hand-tuned greedy party;
// `ctx.params` overrides them per game (falls back here). The tuner only perturbs
// these — structural constants stay inline. Add a knob here rather than burying a
// literal below.
//
// NB (2026-07-09 tuning session): a CEM search over these weights (~500k games)
// found NO vector that beats these defaults on win rate — the greedy heuristic is
// at its representational ceiling; the win-rate lever is game balance, not the
// weights. A "converge harder on the gate" model was also tried and REVERTED (it
// hurt the winnable-variant control). See tools/SELFPLAY_NOTES.md. Kept anyway:
// this parameterization + the tuner are the reusable apparatus for the next
// balance/ruleset change, where the right weights will differ.

export const DEFAULT_PARAMS = {
  // --- safety / draugr ---
  victim: 12,          // penalty per teammate caught in a strike we trigger
  fractureLate: 6,     // extra dread of fractured ground once the stack is thin
  // --- mark gathering ---
  runeReach: 16,       // pull toward a reachable Rune Circle
  runeUrg: 6,          // ...amplified when circles are scarce (urgency)
  onRune: 6,           // bonus for actually stepping onto a circle
  gateFishBase: 1.4,   // once a gate stands, unmarked souls fish toward its doorway...
  gateFishLate: 1.6,   // ...leaning harder as the stack thins (gather marks near home)
  // --- gate march / assembly ---
  march: 3.5,          // march-on-gate pull, marks still outstanding
  marchAll: 5.5,       // ...once every soul is marked (sprint home)
  assembly: 20,        // a lit road home when fully marked outranks all else
  nearGate: 10,        // proximity bonus within 3 of the gate
  // --- cohesion / formation ---
  caravan: 2.2,        // tighten formation once the gate stands and marks gather
  straggler: 9,        // penalty for walking off the gate-connected component late
  rescueLate: 4.5,     // hopeful souls sprint to relight a stranded teammate late
};

// ---------------------------------------------------------------- basics

export function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cellAt = (s, r, c) => s.grid[key(r, c)];
export const tileAt = (s, r, c) => { const cl = cellAt(s, r, c); return cl && cl.tile ? cl.tile : null; };

export function tilesOf(s, kind, gate) {
  const out = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const t = tileAt(s, r, c);
    if (t && t.kind === kind && (gate === undefined || t.gate === gate)) out.push([r, c]);
  }
  return out;
}

// probability the NEXT unknown tile is a Draugr — derived from remaining
// counts, which any table knows from the public discard tracker
const pDraugr = s => (s.stack.length ? s.stack.filter(t => t.kind === 'draugr').length / s.stack.length : 0);

// BFS distances over connected passages from (r,c)
function bfs(s, r0, c0) {
  const dist = new Map([[key(r0, c0), 0]]);
  const q = [[r0, c0]];
  while (q.length) {
    const [r, c] = q.shift();
    const d = dist.get(key(r, c));
    const t = tileAt(s, r, c);
    if (!t) continue;
    for (let dir = 0; dir < 4; dir++) {
      if (!t.exits[dir]) continue;
      const [nr, nc] = stepDir(r, c, dir);
      const nt = tileAt(s, nr, nc);
      if (!nt || !nt.exits[OPP(dir)] || dist.has(key(nr, nc))) continue;
      dist.set(key(nr, nc), d + 1);
      q.push([nr, nc]);
    }
  }
  return dist;
}

const nearest = (dist, cells) => {
  let best = Infinity;
  for (const [r, c] of cells) best = Math.min(best, dist.get(key(r, c)) ?? Infinity);
  return best;
};

// walk a straight sight-lane from (r0,c0) in direction d over a board view
// (getCell may inject a hypothetical tile); returns cells + how the lane ends
function walkLane(getCell, r0, c0, d) {
  const line = [];
  let r = r0, c = c0, end = 'wall';
  for (let i = 0; i < SIZE - 1; i++) {
    const cur = getCell(r, c);
    const t = cur && cur.tile;
    if (!t || !t.exits[d]) { end = 'wall'; break; }
    const [nr, nc] = stepDir(r, c, d);
    if (nr === r0 && nc === c0) { end = 'loop'; break; }
    const ncell = getCell(nr, nc);
    if (!ncell) { end = 'mist'; break; }
    if (ncell.rift) { end = 'rift'; break; }
    if (!ncell.tile.exits[OPP(d)]) { end = 'wall'; break; }
    line.push([nr, nc]);
    r = nr; c = nc;
  }
  return { line, end };
}

const makeGetCell = (s, hyp) => (r, c) =>
  (hyp && r === hyp.r && c === hyp.c) ? { tile: hyp.tile } : cellAt(s, r, c);

const playersOn = (s, cells) => {
  const set = new Set(cells.map(([r, c]) => key(r, c)));
  return s.players.filter(q => q.placed && set.has(key(q.r, q.c))).length;
};

// ---------------------------------------------------------------- the party plan

export function planPantheon(s, ctx) {
  // Commit early — but a gate PLACED on the board is permanent and therefore
  // the only truly safe bet; pivot to it decisively. A gate still in the
  // stack can burn away, orphaning every mark sworn to it.
  const avail = new Set();
  for (const [r, c] of tilesOf(s, 'gate')) avail.add(tileAt(s, r, c).gate);
  for (const t of s.stack) if (t.kind === 'gate') avail.add(t.gate);
  let best = null, bestScore = -Infinity;
  for (const g of avail) {
    const onBoard = tilesOf(s, 'gate', g).length > 0 ? 4 : 1.5;
    const marks = new Set(s.players.filter(q => q.rune && q.rune.p === g).map(q => q.rune.k)).size;
    let score = onBoard + marks * 1.2;
    if (ctx.plan === g) score += 1.0; // hysteresis: don't churn marks on a whim
    if (score > bestScore) { bestScore = score; best = g; }
  }
  const pick = best || ctx.plan || 'valhalla';
  if (ctx.plan && pick !== ctx.plan) ctx.flips = (ctx.flips || 0) + 1;
  ctx.plan = pick;
  return pick;
}

// A gate has ONE doorway: marching must aim at the cell the doorway faces,
// or souls path to the gate's back wall and camp there forever (observed!)
export function gateApproach(s, plan) {
  const gs = tilesOf(s, 'gate', plan);
  if (!gs.length) return null;
  const [gr, gc] = gs[0];
  const t = tileAt(s, gr, gc);
  const d = t.exits.findIndex(Boolean);
  return { gate: [gr, gc], approach: stepDir(gr, gc, d) };
}

export function assemblyMode(s, plan) {
  return tilesOf(s, 'gate', plan).length > 0
    && s.players.every(q => hasGoodMark(s, q, plan));
}

export function hasGoodMark(s, p, plan) {
  if (!p.rune || p.rune.p !== plan) return false;
  return !s.players.some(q => q.seat < p.seat && q.rune
    && q.rune.p === p.rune.p && q.rune.k === p.rune.k);
}

// ---------------------------------------------------------------- placement scoring

// risk of a NON-monster tile placed at (r,c) with these exits: how much sight
// lane does it create/extend, weighted by souls standing in the lane and by
// the odds that the mist at a lane's end coughs up a Draugr
function laneRisk(s, r, c, exits, kind) {
  const getCell = makeGetCell(s, { r, c, tile: { kind, exits } });
  const pD = pDraugr(s);
  let risk = 0;
  for (const [d1, d2] of [[0, 2], [1, 3]]) {
    const cells = [[r, c]];
    let mistEnds = 0, draugrIn = false;
    for (const d of [d1, d2]) {
      if (!exits[d]) continue;
      const { line, end } = walkLane(getCell, r, c, d);
      cells.push(...line);
      if (end === 'mist') mistEnds++;
      if (line.some(([lr, lc]) => { const t = tileAt(s, lr, lc); return t && t.kind === 'draugr'; })) draugrIn = true;
    }
    const souls = playersOn(s, cells);
    if (draugrIn) risk += 9 * (1 + 2 * souls);                      // feeding a live monster's sight
    else risk += pD * mistEnds * (1.2 + 2.4 * souls + 0.12 * cells.length); // future-draw exposure
  }
  return risk;
}

function scorePlacement(s, tile, r, c, rot) {
  if (tile.kind === 'draugr') {
    // damage control: the monster will see the placer regardless (it must
    // connect) — minimize every OTHER soul in its sight and keep lanes short
    const exits = exitsFor(tile.kind, rot);
    const getCell = makeGetCell(s, { r, c, tile: { kind: 'draugr', exits } });
    const seen = [[r, c]];
    for (let d = 0; d < 4; d++) if (exits[d]) seen.push(...walkLane(getCell, r, c, d).line);
    return -(20 * playersOn(s, seen)) - 0.4 * seen.length;
  }
  const exits = exitsFor(tile.kind, rot);
  let score = -laneRisk(s, r, c, exits, tile.kind);
  for (let d = 0; d < 4; d++) {
    if (!exits[d]) continue;
    const [nr, nc] = stepDir(r, c, d);
    if (!cellAt(s, nr, nc)) score += 0.9; // frontier: circles and gates hide in the mist
  }
  if (tile.kind === 'rune' || tile.kind === 'gate') {
    // treasures: any spot beats none, but nearer an unmarked soul is nicer
    score += 2;
    let dmin = 99;
    for (const q of s.players) {
      if (!q.placed) continue;
      dmin = Math.min(dmin, Math.abs(q.r - r) + Math.abs(q.c - c));
    }
    score += 3 / (1 + dmin);
  }
  return score;
}

// ---------------------------------------------------------------- movement scoring

// simulate the strike a move would trigger (pre-move board approximation)
function triggerSim(s, p, mv) {
  const originK = key(p.r, p.c), destK = key(mv.r, mv.c);
  let victims = 0, meHit = false, triggered = false;
  for (const [mr, mc] of tilesOf(s, 'draugr')) {
    const los = losFor(s, mr, mc);
    if (!los.has(originK) && !los.has(destK)) continue;
    triggered = true;
    if (los.has(destK)) meHit = true;
    for (const q of s.players) {
      if (q.placed && q.seat !== p.seat && los.has(key(q.r, q.c))) victims++;
    }
  }
  return { victims, meHit, triggered };
}

function standingDanger(s, r, c) {
  const k = key(r, c);
  for (const [mr, mc] of tilesOf(s, 'draugr')) if (losFor(s, mr, mc).has(k)) return true;
  return false;
}

function goalsFor(s, p, plan) {
  if (!hasGoodMark(s, p, plan)) return { cells: tilesOf(s, 'rune'), kind: 'rune' };
  return { cells: tilesOf(s, 'gate', plan), kind: 'gate' };
}

// the party's rune budget: distinct marks still needed for the plan gate vs.
// circles left anywhere (board + stack). slack is the margin before the game
// is auto-lost — humans treat a thin slack as an emergency and stop wasting
// circles (a Stay burns a random stack tile, ~a circle sometimes).
export function runeEconomy(s, plan) {
  const held = new Set(s.players.filter(q => q.rune && q.rune.p === plan).map(q => q.rune.k));
  const marksNeeded = 4 - held.size;
  let circlesLeft = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const t = tileAt(s, r, c);
    if (t && t.kind === 'rune' && !t.spent) circlesLeft++;
  }
  for (const t of s.stack) if (t.kind === 'rune') circlesLeft++;
  return { marksNeeded, circlesLeft, slack: circlesLeft - marksNeeded };
}

function scoreMove(s, p, mv, plan, rnd, ctx = {}) {
  const P = ctx.params || DEFAULT_PARAMS;
  let score = rnd() * 0.2;
  if (mv.kind === 'jump') {
    // A Void Rift is also a DOOR: fall, then land on any empty unlit cell in
    // its row or column — the party's only teleport. Costly (a turn, a
    // landing tile, you land hopeless) but it beats dying severed from the
    // gate network on a board that will never grow back.
    // the landing happens a full round from now — three other souls will draw
    // and burn tiles in between, so jumping needs a real stack margin
    if (s.stack.length < 7) return -100;
    const lit = litSet(s);
    const ga = gateApproach(s, plan);
    let bestLanding = Infinity;
    for (let i = 0; i < SIZE; i++) {
      for (const [lr, lc] of [[mv.r, i], [i, mv.c]]) {
        if (cellAt(s, lr, lc) || lit.has(key(lr, lc))) continue;
        let v = 0;
        if (ga) v += 0.9 * wrapDist(lr, lc, ga.approach[0], ga.approach[1]);
        let dm = 99;
        for (const q of s.players) {
          if (!q.placed || !q.hopeful || q.seat === p.seat) continue;
          dm = Math.min(dm, wrapDist(lr, lc, q.r, q.c));
        }
        v += 0.6 * Math.min(dm, 8);
        bestLanding = Math.min(bestLanding, v);
      }
    }
    if (bestLanding === Infinity) return -50; // nowhere to land
    let severed = false;
    if (ga) {
      severed = bfs(s, p.r, p.c).get(key(ga.gate[0], ga.gate[1])) === undefined;
    }
    return -7 + (severed ? 8 : 0) + 9 / (1 + bestLanding)
      - (p.resolve === 0 ? 3 : 0) + rnd() * 0.3;
  }
  const sim = triggerSim(s, p, mv);
  score -= P.victim * sim.victims;              // never buy progress with a teammate's hope
  score -= 7 * (sim.meHit ? 1 : 0);
  if (sim.triggered && !sim.meHit && sim.victims === 0 && p.resolve < 2) score += 1.1; // clean evade = free resolve
  if (!sim.meHit && standingDanger(s, mv.r, mv.c)) score -= 4; // don't loiter in a lane either
  const dt = tileAt(s, mv.r, mv.c);
  const { cells: goals, kind: goalKind } = goalsFor(s, p, plan);
  // CORE INSIGHT: paths evaporate behind their only light, so distant goals
  // on the board are illusions. Circles are grabbed when they surface NEARBY;
  // otherwise you keep opening fresh mist (every draw is a lottery ticket for
  // a circle appearing next to you). Only the permanent gate rewards a trek —
  // and you walk to it by carving new paths in its direction, not by BFS over
  // corridors that will be gone next turn.
  const frontier = dt ? [0, 1, 2, 3].reduce((n, d) => {
    if (!dt.exits[d]) return n;
    const [nr, nc] = stepDir(mv.r, mv.c, d);
    return n + (cellAt(s, nr, nc) ? 0 : 1);
  }, 0) : 0;
  if (goalKind === 'rune') {
    // scarcer circles → grab them harder (0 comfortable .. 3 desperate)
    const urg = Math.max(0, 3 - (ctx.econ ? ctx.econ.slack : 9));
    if (dt && goals.length) {
      const dist = bfs(s, mv.r, mv.c);
      // a circle held in a teammate's light is a stable target worth a trek;
      // an unguarded one is only real if we can reach it before it fades
      let bestGoal = Infinity;
      for (const [cr, cc] of goals) {
        const d = dist.get(key(cr, cc)) ?? Infinity;
        const guarded = s.players.some(q => q.placed && q.hopeful && q.seat !== p.seat
          && Math.abs(q.r - cr) + Math.abs(q.c - cc) <= 1);
        if (d <= (guarded ? 5 : 2)) bestGoal = Math.min(bestGoal, d);
      }
      if (bestGoal !== Infinity) score += (P.runeReach + P.runeUrg * urg) / (1 + bestGoal);
      if (dt.kind === 'rune') score += P.onRune + 4 * urg;
    }
    score += (1.2 + 0.5 * urg) * frontier + (mv.kind === 'blind' ? 0.5 : 0); // keep fishing (harder when circles run low)
    // once a plan gate stands, fish TOWARD its doorway — and lean harder as the
    // stack thins, so marks are gathered NEAR the gate and the party clusters
    // there instead of stranding itself across a board that won't grow back
    const ga = gateApproach(s, plan);
    if (ga) {
      const [ar, ac] = ga.approach;
      const lateness = Math.max(0, (28 - s.stack.length) / 9); // 0 early → ~2.5 as the stack empties
      score += (P.gateFishBase + P.gateFishLate * lateness) * (wrapDist(p.r, p.c, ar, ac) - wrapDist(mv.r, mv.c, ar, ac));
    }
  } else {
    if (dt && dt.kind === 'rune') score -= 6; // a marked soul crumbles it for nothing
    const allMarked = s.players.every(q => hasGoodMark(s, q, plan));
    if (goals.length) {
      // aim the march at the DOORWAY cell, not the gate's back wall
      const ga = gateApproach(s, plan);
      const [gr, gc] = ga ? ga.approach : goals[0];
      const d0 = wrapDist(p.r, p.c, gr, gc);
      const d1 = wrapDist(mv.r, mv.c, gr, gc);
      score += (allMarked ? P.marchAll : P.march) * (d0 - d1); // march on the gate; sprint when the set is complete
      const dmin = dt ? nearest(bfs(s, mv.r, mv.c), goals) : Infinity;
      if (dmin <= 3) score += P.nearGate / (1 + dmin);
      // ASSEMBLY: with all four marks sworn and the gate standing, a lit road
      // home outranks every other consideration — follow it and do not let go
      if (allMarked && dmin !== Infinity) score += P.assembly / (1 + dmin);
      if (dt && dt.kind === 'gate' && dt.gate === plan) score += 8;
      // every open passage at the destination forces a draw: during the march
      // each sideways opening burns stack for nothing — only openings that
      // face the gate are a path; the rest are leaks
      if (dt) {
        for (let d = 0; d < 4; d++) {
          if (!dt.exits[d]) continue;
          const [nr, nc] = stepDir(mv.r, mv.c, d);
          if (cellAt(s, nr, nc)) continue;
          const toward = wrapDist(nr, nc, gr, gc) < wrapDist(mv.r, mv.c, gr, gc);
          score += toward ? 0.7 : (s.stack.length < 25 ? -0.5 : 0.1);
        }
      }
    } else {
      score += (allMarked ? 1.3 : 0.9) * frontier; // the gate hides in the mist too
    }
  }
  // loose formation: souls more than ~3 apart can't relight or shield each
  // other — and once the gate stands and marks are gathering, the party
  // tightens into a CARAVAN so one shared road can carry everyone home
  {
    let dMate = Infinity;
    for (const q of s.players) {
      if (!q.placed || q.seat === p.seat) continue;
      dMate = Math.min(dMate, wrapDist(mv.r, mv.c, q.r, q.c));
    }
    const marks = s.players.filter(q => hasGoodMark(s, q, plan)).length;
    const caravan = tilesOf(s, 'gate', plan).length > 0 && marks >= 2;
    if (dMate !== Infinity) {
      score -= (caravan ? P.caravan : 1.2) * Math.max(0, dMate - (caravan ? 2 : 3));
    }
  }
  // a hopeless soul on a dead end is one forced Stay from tumbling forever
  if (!p.hopeful && dt && dt.exits.filter(Boolean).length <= 1) score -= 3;
  // anti-dither: shuffling back to last turn's tile burns the forest for nothing
  const last = ctx.lastCell && ctx.lastCell[p.seat];
  if (last && last[0] === mv.r && last[1] === mv.c && !(dt && dt.kind === 'gate')) score -= 1.6;

  // THE STRAGGLER RULE: the anchor is the GATE NETWORK, not just any teammate
  // (pairs happily drift apart together and strand 2+2 — observed). Once the
  // gate stands, staying on its connected component is the road home; walking
  // off it late in the game is a lonely grave.
  if (dt && dt.kind !== 'gate') {
    const ga = gateApproach(s, plan);
    const dist = bfs(s, mv.r, mv.c);
    if (ga) {
      const gateConnected = dist.get(key(ga.gate[0], ga.gate[1])) !== undefined;
      const allMarked = s.players.every(q => hasGoodMark(s, q, plan));
      if (gateConnected) score += 1.5;
      else if (s.stack.length < 25 || allMarked) score -= P.straggler;
    } else if (s.stack.length < 25) {
      const connected = s.players.some(q => q.placed && q.seat !== p.seat
        && dist.get(key(q.r, q.c)) !== undefined);
      if (!connected) score -= P.straggler;
    }
  }
  // cohesion: hopeful souls drift toward the hopeless to relight them,
  // hopeless souls seek the light
  if (dt) {
    const dist = bfs(s, mv.r, mv.c);
    if (p.hopeful) {
      const dark = s.players.filter(q => q.placed && !q.hopeful && q.seat !== p.seat).map(q => [q.r, q.c]);
      // a stranded hopeless soul in the late game is a countdown to a fatal
      // fall — rescue outranks nearly everything once the stack runs thin
      if (dark.length) score += (s.stack.length < 15 ? P.rescueLate : 2.5) / (1 + nearest(dist, dark));
    } else {
      const lit = s.players.filter(q => q.placed && q.hopeful).map(q => [q.r, q.c]);
      if (lit.length) score += 3.5 / (1 + nearest(dist, lit));
    }
  }
  // fractured ground is a delayed fall — and a fall when the stack runs thin
  // is a death sentence (nothing left to land on)
  if (dt && dt.fractured && dt.kind !== 'rune') {
    score -= 2.2 + (goalKind === 'gate' ? 2 : 0) + (s.stack.length < 15 ? P.fractureLate : 0);
  }
  if (mv.kind === 'blind') score -= 2.2 * pDraugr(s); // stepping into the unknown

  // guard duty: if my light alone keeps a circle on the board and a teammate
  // still needs it, don't let it fade into the mist
  if (p.hopeful) {
    const myTile = tileAt(s, p.r, p.c);
    const someoneNeeds = s.players.some(q => q.placed && !hasGoodMark(s, q, plan));
    if (myTile && someoneNeeds) {
      for (let d = 0; d < 4; d++) {
        if (!myTile.exits[d]) continue;
        const [nr, nc] = stepDir(p.r, p.c, d);
        const nt = tileAt(s, nr, nc);
        if (!nt || nt.kind !== 'rune') continue;
        if (mv.r === nr && mv.c === nc) continue; // stepping ONTO it is fine
        const othersLight = s.players.some(q => {
          if (!q.placed || !q.hopeful || q.seat === p.seat) return false;
          if (Math.abs(q.r - nr) + Math.abs(q.c - nc) !== 1) return false;
          const qt = tileAt(s, q.r, q.c);
          return qt && [0, 1, 2, 3].some(dd => qt.exits[dd]
            && stepDir(q.r, q.c, dd)[0] === nr && stepDir(q.r, q.c, dd)[1] === nc);
        });
        const stillLitAfter = Math.abs(mv.r - nr) + Math.abs(mv.c - nc) <= 1;
        if (!othersLight && !stillLitAfter) score -= 6;
      }
    }
  }
  return score;
}

// ---------------------------------------------------------------- rollout lookahead
//
// Greedy play is blind to consequences three moves out (which circle-grab
// strands you, which step wakes the draugr chain that fragments the party).
// A rollout gives the party human-like ANTICIPATION: try a candidate action,
// then let the fast greedy policy finish the game over a RESHUFFLED unknown
// stack (the bot knows only the remaining tile counts, like the discard
// tracker — never the order), and keep the action with the best expected
// outcome. Enabled by ctx.rollouts (0 = pure greedy, the rollouts' own base).

// deep clone of the engine state, minus the append-only log/event history the
// engine writes but never branches on (keeps the clone cheap)
// lean deep clone of ONLY the fields the engine mutates during a rollout — far
// faster than structuredClone (which pays generic-clone overhead on the grid +
// stack every call, the perf bottleneck of the search). The append-only display
// fields (log/events/turnEvents/lastTurn) are reset empty; the engine writes but
// never branches on them. Validated to give identical rollout results to
// structuredClone (same seed → identical win counts), so the search is unchanged
// in behaviour but much cheaper — which buys deeper/wider lookahead.
const cloneTile = t => t && { id: t.id, kind: t.kind, fractured: t.fractured, gate: t.gate, rot: t.rot, exits: t.exits ? t.exits.slice() : t.exits, spent: t.spent };
const cloneCell = cl => !cl ? null : (cl.rift ? { rift: true } : { tile: cloneTile(cl.tile) });
function cloneNode(node) { // one-level deep copy of a queue step / awaiting (nested arrays/objects copied)
  const o = {};
  for (const k in node) {
    const v = node[k];
    o[k] = Array.isArray(v) ? v.map(x => Array.isArray(x) ? x.slice() : (x && typeof x === 'object' ? { ...x } : x))
      : (v && typeof v === 'object' ? { ...v } : v);
  }
  return o;
}
function cloneState(s) {
  return {
    v: s.v, startedAt: s.startedAt, turnsTaken: s.turnsTaken, phase: s.phase,
    grid: s.grid.map(cloneCell),
    stack: s.stack.map(cloneTile),
    discard: s.discard.map(cloneTile),
    players: s.players.map(p => ({ ...p, rune: p.rune ? { ...p.rune } : null, falling: p.falling ? { ...p.falling } : null })),
    turn: s.turn,
    queue: s.queue.map(cloneNode),
    awaiting: s.awaiting ? cloneNode(s.awaiting) : null,
    niflheim: s.niflheim, winnerGate: s.winnerGate, lossReason: s.lossReason,
    log: [], events: [], turnEvents: [], lastTurn: null,
    turnOwner: s.turnOwner, rngState: s.rngState, tileSeq: s.tileSeq,
    moveCtx: s.moveCtx ? { ...s.moveCtx } : null,
    pendingHit: s.pendingHit ? { ...s.pendingHit } : null,
    blindCtx: s.blindCtx ? { ...s.blindCtx } : null,
    movesThisTurn: s.movesThisTurn,
    randomRunes: s.randomRunes,
    tileTotals: { ...s.tileTotals },
  };
}

function resampleStack(c, rnd) {
  const a = c.stack;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  c.rngState = (rnd() * 2 ** 31) | 0; // vary the engine's own RNG (random-runes) too
}

// how close a finished (or terminal) rollout came to the win — a win dwarfs
// everything, but partial progress (marks gathered, souls on the gate) gives
// the search a gradient even among the many losing lines. Measured on the BEST
// gate, so a rollout that pivoted to the other pantheon still scores its work.
function rolloutReward(s) {
  if (s.phase === 'won') return 1000;
  let best = 0;
  for (const g of ['valhalla', 'folkvangr']) {
    const held = new Set(s.players.filter(q => q.rune && q.rune.p === g).map(q => q.rune.k));
    const gs = tilesOf(s, 'gate', g);
    let onGate = 0, connected = 0;
    if (gs.length) {
      const [gr, gc] = gs[0];
      const dist = bfs(s, gr, gc);
      const gset = new Set(gs.map(([r, c]) => key(r, c)));
      for (const q of s.players) {
        if (!q.placed) continue;
        if (gset.has(key(q.r, q.c))) onGate++;                       // home
        else if (dist.get(key(q.r, q.c)) !== undefined) connected++; // still has a road home
      }
    }
    // reward marks, being home, AND staying connected to the gate — the last
    // is what separates "lost but assembling" from "lost, party fragmented"
    best = Math.max(best, held.size * 40 + onGate * 22 + connected * 8 + (gs.length ? 12 : 0));
  }
  return best;
}

function rolloutToEnd(c, rnd, plan, usePlanner) {
  // no nesting (rollouts:0); usePlanner makes the rollout PLAN-FOLLOWING, so the
  // search evaluates "where does the party's plan end up" rather than greedy play.
  const rctx = { plan, rollouts: 0, usePlanner };
  let steps = 0;
  while (c.phase !== 'won' && c.phase !== 'lost') {
    if (++steps > 4000 || (c.awaiting == null)) { c.phase = 'lost'; break; }
    applyAction(c, c.awaiting.seat, policy(c, rnd, rctx));
  }
  return rolloutReward(c);
}

// expected outcome of taking `action` now, over M reshuffled futures
function rolloutValue(s, rnd, ctx, action) {
  let total = 0;
  for (let m = 0; m < ctx.rollouts; m++) {
    const c = cloneState(s);
    resampleStack(c, rnd);
    applyAction(c, c.awaiting.seat, action);
    total += rolloutToEnd(c, rnd, ctx.plan, ctx.usePlanner);
  }
  return total / ctx.rollouts;
}

// ================================================================ THE PLANNER
//
// Opt-in (ctx.usePlanner / --planner). A human does not score single moves — they
// hold a MULTI-TURN PLAN for the whole party and drive each soul toward its role
// in it. computePlan assigns, every turn, a concrete goal to every soul; the party
// then executes the plan (with an optional plan-following lookahead). The point is
// JOINT reasoning: gather the RIGHT marks, on the CONNECTED road, and converge in
// time — the coupling the greedy per-move heuristic structurally cannot handle.

export function computePlan(s, ctx) {
  const plan = planPantheon(s, ctx);
  const ga = gateApproach(s, plan);
  const econ = runeEconomy(s, plan);
  const placed = s.players.filter(q => q.placed);
  const good = q => hasGoodMark(s, q, plan);
  const dists = new Map();
  for (const q of placed) dists.set(q.seat, bfs(s, q.r, q.c));
  const circles = tilesOf(s, 'rune').filter(([r, c]) => { const t = tileAt(s, r, c); return t && !t.spent; });

  const assign = {};
  // JOINT 1:1 assignment: give each reachable circle to the nearest unmarked soul,
  // shortest treks first, so no two souls chase the same stone and the marks come
  // off circles closest to the party (near the connected road, not far corners).
  const cands = [];
  for (const q of placed) {
    if (good(q)) continue;
    const dm = dists.get(q.seat);
    for (const [cr, cc] of circles) {
      const dd = dm.get(key(cr, cc));
      if (dd !== undefined) cands.push([q.seat, cr, cc, dd]);
    }
  }
  cands.sort((a, b) => a[3] - b[3]);
  const soulTaken = new Set(), circTaken = new Set();
  for (const [seat, cr, cc, dd] of cands) {
    if (soulTaken.has(seat) || circTaken.has(key(cr, cc))) continue;
    assign[seat] = { goal: 'rune', target: [cr, cc], d: dd };
    soulTaken.add(seat); circTaken.add(key(cr, cc));
  }
  // an unmarked soul with no reachable circle FISHES toward the gate region (its
  // moves open fresh mist — a chance to surface a circle — while trending home).
  for (const q of placed) if (!good(q) && !assign[q.seat]) {
    assign[q.seat] = { goal: 'fish', target: ga ? ga.approach : null };
  }
  // a marked soul converges on the doorway — UNLESS its light is holding a circle
  // an unmarked teammate is assigned to and hasn't reached yet (guard duty).
  for (const q of placed) {
    if (!good(q)) continue;
    let guard = null;
    for (const seat of soulTaken) {
      const a = assign[seat]; if (!a || a.goal !== 'rune') continue;
      const [cr, cc] = a.target; const owner = s.players[seat];
      if (owner.r === cr && owner.c === cc) continue;
      if (Math.abs(q.r - cr) + Math.abs(q.c - cc) === 1) { guard = [cr, cc]; break; }
    }
    assign[q.seat] = guard ? { goal: 'guard', target: guard }
      : { goal: 'gate', target: ga ? ga.approach : null };
  }
  return { plan, ga, econ, assign };
}

// score a move by how well it advances THIS soul's assigned goal, plus the party
// viability terms a plan must respect (never strike a teammate; stay on the road
// home; don't crumble a circle you don't need).
function scorePlanMove(s, p, mv, P2, rnd, ctx) {
  if (mv.kind === 'jump') return scoreMove(s, p, mv, P2.plan, rnd, ctx); // rare; reuse greedy valuation
  const a = P2.assign[p.seat] || { goal: 'fish', target: P2.ga ? P2.ga.approach : null };
  let score = rnd() * 0.1;
  const sim = triggerSim(s, p, mv);
  score -= 12 * sim.victims;
  score -= 7 * (sim.meHit ? 1 : 0);
  if (sim.triggered && !sim.meHit && sim.victims === 0 && p.resolve < 2) score += 1.0; // clean evade
  if (!sim.meHit && standingDanger(s, mv.r, mv.c)) score -= 3;
  const dt = tileAt(s, mv.r, mv.c);
  if (a.target) {
    const [tr, tc] = a.target;
    score += 3.0 * (wrapDist(p.r, p.c, tr, tc) - wrapDist(mv.r, mv.c, tr, tc)); // progress toward goal
    if (a.goal === 'rune' && mv.r === tr && mv.c === tc) score += 20;           // step onto my circle
    if (a.goal === 'gate') {
      if (dt && dt.kind === 'gate' && dt.gate === P2.plan) score += 20;
      const dmin = dt ? nearest(bfs(s, mv.r, mv.c), tilesOf(s, 'gate', P2.plan)) : Infinity;
      if (dmin <= 3) score += 10 / (1 + dmin);
    }
  }
  if (a.goal === 'fish' || a.goal === 'rune') {
    const frontier = dt ? [0, 1, 2, 3].reduce((n, d) => {
      if (!dt.exits[d]) return n; const [nr, nc] = stepDir(mv.r, mv.c, d); return n + (cellAt(s, nr, nc) ? 0 : 1);
    }, 0) : 0;
    score += (a.goal === 'fish' ? 1.6 : 0.6) * frontier + (mv.kind === 'blind' ? 0.5 : 0);
  }
  // VIABILITY: stay on the gate-connected component — the anti-fragmentation term
  if (P2.ga && dt && dt.kind !== 'gate') {
    const conn = bfs(s, mv.r, mv.c).get(key(P2.ga.gate[0], P2.ga.gate[1])) !== undefined;
    if (conn) score += 1.5; else if (s.stack.length < 30) score -= 6;
  }
  if (dt && dt.kind === 'rune' && hasGoodMark(s, p, P2.plan)) score -= 6; // don't crumble a spare circle
  if (dt && dt.fractured && dt.kind !== 'rune') score -= 2 + (s.stack.length < 15 ? 5 : 0);
  if (mv.kind === 'blind') score -= 2 * pDraugr(s);
  return score;
}

// NOTE: smart Berserk/charge was implemented and measured (2026-07-09) — it does
// NOT help. Eager charging HURT (Normal 0.31→0.23%); a strict "only banish a
// draugr on the gate funnel, with Resolve to Brace" version fired so rarely it was
// a no-op (0.31→0.31%). The planner already avoids draugr sight-lines, so paying a
// Resolve + a 3-tile self-hit + a hopeless soul to remove one is a losing trade.
// Left out on purpose. (See tools/SELFPLAY_NOTES.md.)

// planner brain for the decisions that matter (movement, attunement); other
// decision types (placements, niflheim, scramble, block, fall-landing) fall back
// to the proven greedy handlers.
function plannerDecision(s, rnd, ctx) {
  const aw = s.awaiting;
  if (aw.type !== 'action' && aw.type !== 'post-move' && aw.type !== 'attune') return null;
  const p = s.players[aw.seat];
  const P2 = computePlan(s, ctx);
  ctx.econ = P2.econ;
  const a = P2.assign[p.seat] || { goal: 'fish', target: P2.ga ? P2.ga.approach : null };
  const good = hasGoodMark(s, p, P2.plan);
  const myTile = tileAt(s, p.r, p.c);

  if (aw.type === 'attune') {
    if (aw.random) return good ? { skip: true } : { draw: true };
    if (good) return { skip: true };
    const held = new Set(s.players.filter(q => q.seat !== p.seat && q.rune && q.rune.p === P2.plan).map(q => q.rune.k));
    const free = RUNES[P2.plan].filter(rn => !held.has(rn.k));
    return free.length ? { p: P2.plan, k: free[0].k } : { skip: true };
  }

  if (aw.type === 'action') {
    if (myTile && myTile.kind === 'gate' && myTile.gate === P2.plan && good && aw.stay) return { kind: 'stay' };
    if (aw.stay && s.randomRunes && myTile && myTile.kind === 'rune' && !good && s.stack.length > 6) return { kind: 'stay' };
    if (aw.rekindle) {
      const adj = myTile && [0, 1, 2, 3].some(d => {
        if (!myTile.exits[d]) return false; const [nr, nc] = stepDir(p.r, p.c, d); const nt = tileAt(s, nr, nc);
        return nt && nt.exits[OPP(d)] && s.players.some(q => q.placed && q.hopeful && q.r === nr && q.c === nc);
      });
      if (!adj) return { kind: 'rekindle' };
    }
    // GUARD DUTY: my role is to hold a circle lit for an incoming teammate → stand fast
    if (a.goal === 'guard' && aw.stay && myTile && !myTile.fractured && !standingDanger(s, p.r, p.c)) return { kind: 'stay' };
    // score every option toward my goal; Stay is a real candidate (the plan may
    // want me to hold position). With --rollouts, the top few are rolled out
    // PLAN-FOLLOWING — genuine anticipation of where the party's plan ends up.
    if (ctx.rollouts > 0) {
      // LOOKAHEAD: Stay is a real candidate; roll out the top few PLAN-FOLLOWING —
      // genuine anticipation of where the party's plan ends up.
      const cands = [];
      for (const m of aw.moves) { if (m.kind === 'charge') continue; cands.push({ m, base: scorePlanMove(s, p, m, P2, rnd, ctx) }); }
      if (aw.stay) cands.push({ m: { kind: 'stay' }, base: a.goal === 'guard' ? 0.5 : -0.5 });
      if (!cands.length) return aw.stay ? { kind: 'stay' } : { kind: 'move', d: aw.moves[0].d };
      cands.sort((x, y) => y.base - x.base);
      let best = cands[0].m, bestVal = -Infinity;
      for (let i = 0; i < Math.min(cands.length, 3); i++) {
        const c = cands[i];
        const action = c.m.kind === 'stay' ? { kind: 'stay' } : { kind: 'move', d: c.m.d };
        const val = c.base + 0.06 * rolloutValue(s, rnd, { ...ctx, plan: P2.plan }, action) + rnd() * 0.05;
        if (val > bestVal) { bestVal = val; best = c.m; }
      }
      if (best.kind === 'stay') return { kind: 'stay' };
      (ctx.lastCell = ctx.lastCell || {})[p.seat] = [p.r, p.c];
      return { kind: 'move', d: best.d };
    }
    // greedy plan path: drive toward the goal (souls keep moving — Staying just
    // burns the tile budget; guard/beachhead Stays are handled explicitly above).
    let best = null, bestScore = -Infinity;
    for (const m of aw.moves) {
      if (m.kind === 'charge') continue;
      const sc = scorePlanMove(s, p, m, P2, rnd, ctx);
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    if (best && best.kind === 'jump' && aw.stay && bestScore <= -10) return { kind: 'stay' };
    if (best) { (ctx.lastCell = ctx.lastCell || {})[p.seat] = [p.r, p.c]; return { kind: 'move', d: best.d }; }
    return aw.stay ? { kind: 'stay' } : { kind: 'move', d: aw.moves[0].d };
  }

  // post-move: press on toward the goal when it helps and resolve is spare
  if (aw.canMoveAgain && p.resolve > 0 && aw.moves.length) {
    if (myTile && myTile.kind === 'gate' && myTile.gate === P2.plan) return { kind: 'end' };
    let best = null, bestScore = 1.0;
    for (const m of aw.moves) { if (m.kind !== 'move') continue; const sc = scorePlanMove(s, p, m, P2, rnd, ctx); if (sc > bestScore) { bestScore = sc; best = m; } }
    if (best && (standingDanger(s, p.r, p.c) || p.resolve === 2 || a.goal === 'gate')) {
      (ctx.lastCell = ctx.lastCell || {})[p.seat] = [p.r, p.c];
      return { kind: 'move', d: best.d };
    }
  }
  return { kind: 'end' };
}

// ---------------------------------------------------------------- policy

export function policy(s, rnd, ctx) {
  const aw = s.awaiting;
  const p = s.players[aw.seat];
  if (ctx.usePlanner) {
    const d = plannerDecision(s, rnd, ctx);
    if (d) return d; // else fall through to greedy for placements/niflheim/scramble/etc.
  }
  const plan = planPantheon(s, ctx);
  ctx.econ = runeEconomy(s, plan); // shared rune budget for this decision

  switch (aw.type) {
    case 'place-start': {
      // spread out, but not to opposite corners — mutual rescue range matters
      let best = null, bestScore = -Infinity;
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
        if (cellAt(s, r, c)) continue;
        let dmin = Infinity;
        for (const q of s.players) {
          if (!q.placed) continue;
          const dr = Math.min(Math.abs(q.r - r), SIZE - Math.abs(q.r - r));
          const dc = Math.min(Math.abs(q.c - c), SIZE - Math.abs(q.c - c));
          dmin = Math.min(dmin, dr + dc);
        }
        // 2-3 apart is the sweet spot: near enough to relight each other,
        // far enough that one Draugr lane can't rake two souls
        const score = dmin === Infinity
          ? 2.5 + rnd()
          : Math.min(dmin, 3) - Math.max(0, dmin - 4) * 0.5 + rnd();
        if (score > bestScore) { bestScore = score; best = { r, c, rot: Math.floor(rnd() * 4) }; }
      }
      return best;
    }

    case 'place-tile': {
      let best = null, bestScore = -Infinity;
      for (const tg of aw.targets) {
        for (const rot of tg.rots) {
          const score = scorePlacement(s, aw.tile, tg.r, tg.c, rot) + rnd() * 0.2;
          if (score > bestScore) { bestScore = score; best = { r: tg.r, c: tg.c, rot }; }
        }
      }
      return best;
    }

    case 'place-blind':
    case 'place-landing':
    case 'place-scramble': {
      let best = aw.rots[0], bestScore = -Infinity;
      for (const rot of aw.rots) {
        const score = scorePlacement(s, aw.tile, aw.r, aw.c, rot) + rnd() * 0.2;
        if (score > bestScore) { bestScore = score; best = rot; }
      }
      return { rot: best };
    }

    case 'action': {
      const myTile = tileAt(s, p.r, p.c);
      const good = hasGoodMark(s, p, plan);
      // BEACHHEAD: a soul already on the gate never leaves — their light keeps
      // the doorway tile alive for everyone still walking in
      if (myTile && myTile.kind === 'gate' && myTile.gate === plan && good && aw.stay) {
        return { kind: 'stay' };
      }
      // random-runes linger: reroll on the circle until the mark serves the plan
      if (aw.stay && s.randomRunes && myTile && myTile.kind === 'rune' && !good && s.stack.length > 6) {
        return { kind: 'stay' };
      }
      if (aw.rekindle) {
        // a hopeful neighbor relights us for free — only pay when alone
        const adjacentLight = myTile && [0, 1, 2, 3].some(d => {
          if (!myTile.exits[d]) return false;
          const [nr, nc] = stepDir(p.r, p.c, d);
          const nt = tileAt(s, nr, nc);
          return nt && nt.exits[OPP(d)]
            && s.players.some(q => q.placed && q.hopeful && q.r === nr && q.c === nc);
        });
        if (!adjacentLight) return { kind: 'rekindle' };
      }
      // ROLLOUT LOOKAHEAD: keep the greedy heuristic as the primary ranking
      // (it encodes hard-won wisdom), then ADJUST each option by how the game
      // tends to END if we take it — over reshuffled futures. The greedy score
      // guards against noise; the rollout adds the anticipation greed lacks.
      if (ctx.rollouts > 0) {
        const onFrac = myTile && myTile.fractured;
        const cands = [];
        for (const m of aw.moves) {
          if (m.kind === 'charge') continue;
          cands.push({ action: { kind: 'move', d: m.d }, greedy: scoreMove(s, p, m, plan, rnd, ctx) });
        }
        // a Stay's greedy value ≈ a mediocre-but-safe move; the rollout decides
        if (aw.stay) cands.push({ action: { kind: 'stay' }, greedy: onFrac ? -8 : 0.4 });
        if (!cands.length) return { kind: 'move', d: aw.moves[0].d };
        // only roll out the plausible options — greedy already ranks them, so
        // the top few are where lookahead actually earns its cost
        cands.sort((a, b) => b.greedy - a.greedy);
        const K = Math.min(cands.length, 4);
        let best = cands[0], bestVal = -Infinity;
        for (let i = 0; i < K; i++) {
          const cand = cands[i];
          const val = cand.greedy + 0.06 * rolloutValue(s, rnd, ctx, cand.action) + rnd() * 0.05;
          if (val > bestVal) { bestVal = val; best = cand; }
        }
        if (best.action.kind === 'move') (ctx.lastCell = ctx.lastCell || {})[p.seat] = [p.r, p.c];
        return best.action;
      }
      let best = null, bestScore = -Infinity;
      for (const m of aw.moves) {
        if (m.kind === 'charge') continue; // v2 still never charges (candidate v3 tool)
        const score = scoreMove(s, p, m, plan, rnd, ctx);
        if (score > bestScore) { bestScore = score; best = m; }
      }
      const onFractured = myTile && myTile.fractured;
      const inDanger = standingDanger(s, p.r, p.c);
      // GUARD DUTY: a marked soul lighting a circle holds position while an
      // unmarked teammate treks in — a burned tile per turn buys a whole mark
      if (aw.stay && !onFractured && !inDanger && p.hopeful && good) {
        const guarding = myTile && [0, 1, 2, 3].some(d => {
          if (!myTile.exits[d]) return false;
          const [nr, nc] = stepDir(p.r, p.c, d);
          const nt = tileAt(s, nr, nc);
          if (!nt || nt.kind !== 'rune') return false;
          // someone unmarked is close enough to come claim it
          return s.players.some(q => {
            if (!q.placed || q.seat === p.seat || hasGoodMark(s, q, plan)) return false;
            const dd = Math.abs(q.r - nr) + Math.abs(q.c - nc);
            return dd >= 1 && dd <= 5;
          });
        });
        if (guarding) return { kind: 'stay' };
      }
      // staying burns a random stack tile — an ~8% chance of eating a rune
      // circle — so only stand fast when broke, truly idle, AND circles are
      // plentiful. With a thin rune budget a Stay can burn the win; a human
      // would rather explore (a move at least fishes for a circle).
      if (aw.stay && !onFractured && !inDanger && p.hopeful
        && p.resolve === 0 && s.stack.length > 12 && ctx.econ.slack >= 3
        && (best === null || bestScore < 0.9)) {
        return { kind: 'stay' };
      }
      // NEVER leap into the void just because it is the only road: a soul
      // standing on solid ground survives to be rescued; a late-game fall is
      // death (this exact bug killed fully-marked parties one tile from home)
      if (best && bestScore <= -10 && aw.stay && !onFractured) {
        return { kind: 'stay' };
      }
      if (best) {
        (ctx.lastCell = ctx.lastCell || {})[p.seat] = [p.r, p.c];
        return { kind: 'move', d: best.d };
      }
      return aw.stay ? { kind: 'stay' } : { kind: 'move', d: aw.moves[0].d };
    }

    case 'post-move': {
      if (aw.canMoveAgain && p.resolve > 0 && aw.moves.length) {
        // escape a sight lane, or close the final steps to the gate
        const inDanger = standingDanger(s, p.r, p.c);
        const { cells: goals, kind } = goalsFor(s, p, plan);
        let best = null, bestScore = inDanger ? -2 : 1.2;
        const allMarked = s.players.every(q => hasGoodMark(s, q, plan));
        // never move-again OFF the gate
        const here = tileAt(s, p.r, p.c);
        if (here && here.kind === 'gate' && here.gate === plan) return { kind: 'end' };
        for (const m of aw.moves) {
          if (m.kind !== 'move') continue;
          const score = scoreMove(s, p, m, plan, rnd, ctx)
            + (kind === 'gate' && p.resolve === 2 ? 1 : 0)
            // hoard the last resolve for Brace/Rekindle — except during the
            // final march, when speed IS survival
            - (p.resolve === 1 && !inDanger && !allMarked ? 1.5 : 0);
          if (score > bestScore) { bestScore = score; best = m; }
        }
        if (best && (inDanger || p.resolve === 2 || (kind === 'gate' && goals.length))) {
          (ctx.lastCell = ctx.lastCell || {})[p.seat] = [p.r, p.c];
          return { kind: 'move', d: best.d };
        }
      }
      return { kind: 'end' };
    }

    case 'attune': {
      const good = hasGoodMark(s, p, plan);
      if (aw.random) return good ? { skip: true } : { draw: true };
      if (good) return { skip: true };
      const held = new Set(s.players.filter(q => q.seat !== p.seat && q.rune && q.rune.p === plan).map(q => q.rune.k));
      const free = RUNES[plan].filter(rn => !held.has(rn.k));
      if (free.length) return { p: plan, k: free[0].k };
      return { skip: true };
    }

    case 'block':
      // keep one resolve for Rekindle (the strike leaves us hopeless);
      // spend the spare, or pay anyway when the stack is nearly ash
      return { block: p.resolve >= 2 || s.stack.length < 12 };

    case 'swap-draugr': {
      // the monster must land somewhere connected — pick where it sees least
      let best = aw.options[0], bestScore = -Infinity;
      for (const o of aw.options) {
        const seen = [[o.r, o.c]];
        const getCell = makeGetCell(s, { r: o.r, c: o.c, tile: { kind: 'draugr', exits: [1, 1, 1, 1] } });
        for (let d = 0; d < 4; d++) seen.push(...walkLane(getCell, o.r, o.c, d).line);
        const score = -(20 * playersOn(s, seen)) - 0.4 * seen.length + rnd() * 0.2;
        if (score > bestScore) { bestScore = score; best = o; }
      }
      return { r: best.r, c: best.c };
    }

    case 'fall-landing': {
      // land near the light — and near the gate, since that is where every
      // road leads — never inside a monster's stare
      const gates = tilesOf(s, 'gate', plan);
      let best = aw.options[0], bestScore = -Infinity;
      for (const o of aw.options) {
        let dmin = 99;
        for (const q of s.players) {
          if (!q.placed || !q.hopeful) continue;
          dmin = Math.min(dmin, Math.abs(q.r - o.r) + Math.abs(q.c - o.c));
        }
        let dGate = 0;
        const ga = gateApproach(s, plan);
        if (ga) {
          const [ar, ac] = ga.approach;
          dGate = Math.abs(ar - o.r) + Math.abs(ac - o.c);
        }
        const score = -(standingDanger(s, o.r, o.c) ? 8 : 0) - dmin - 0.8 * dGate + rnd() * 0.3;
        if (score > bestScore) { bestScore = score; best = o; }
      }
      return { r: best.r, c: best.c };
    }

    case 'scramble': {
      const safe = aw.options.filter(o => !standingDanger(s, o.r, o.c));
      const pool = safe.length ? safe : aw.options;
      const solid = pool.filter(o => !o.draw);
      const pick = (solid.length ? solid : pool)[0];
      return { r: pick.r, c: pick.c };
    }

    case 'niflheim': {
      // give the cold what the party needs least: far tiles, never circles,
      // never anything hugging the gate — and NEVER a stone on someone's
      // shortest road home
      const gates = tilesOf(s, 'gate', plan);
      const sacred = new Set();
      if (gates.length) {
        const [gr, gc] = gates[0];
        const fromGate = bfs(s, gr, gc);
        for (const q of s.players) {
          if (!q.placed) continue;
          const fromQ = bfs(s, q.r, q.c);
          const dHome = fromQ.get(key(gr, gc));
          if (dHome === undefined) continue;
          for (const o of aw.options) {
            const a = fromQ.get(key(o.r, o.c));
            const b = fromGate.get(key(o.r, o.c));
            if (a !== undefined && b !== undefined && a + b === dHome) sacred.add(key(o.r, o.c));
          }
        }
      }
      let best = aw.options[0], bestScore = -Infinity;
      for (const o of aw.options) {
        const t = tileAt(s, o.r, o.c);
        let dPlayers = 99;
        for (const q of s.players) {
          if (!q.placed) continue;
          dPlayers = Math.min(dPlayers, Math.abs(q.r - o.r) + Math.abs(q.c - o.c));
        }
        let dGate = 99;
        for (const [gr, gc] of gates) dGate = Math.min(dGate, Math.abs(gr - o.r) + Math.abs(gc - o.c));
        const score = dPlayers + 0.5 * dGate
          - (t && t.kind === 'rune' ? 12 : 0)
          - (dGate <= 1 ? 6 : 0)
          - (sacred.has(key(o.r, o.c)) ? 15 : 0)
          + rnd() * 0.2;
        if (score > bestScore) { bestScore = score; best = o; }
      }
      // during the final assembly every remaining tile may be the road home:
      // pay resolve to hold the forest together
      const assembling = s.players.every(q => hasGoodMark(s, q, plan))
        && tilesOf(s, 'gate', plan).length > 0
        && !s.players.every(q => {
          const t = q.placed && tileAt(s, q.r, q.c);
          return t && t.kind === 'gate';
        });
      if (p.resolve > 0 && (assembling || (p.resolve > 1 && bestScore < 2))) return { sustain: true };
      return { r: best.r, c: best.c };
    }

    default:
      throw new Error('policy has no handler for awaiting type: ' + aw.type);
  }
}


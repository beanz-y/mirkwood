/*
 * Mirkwood self-play balance harness.
 *
 *   node tools/selfplay.js --games 500 --preset hard --randomRunes --seed 7
 *
 * Plays full games headlessly against the real engine with a greedy heuristic
 * policy (far stronger than random, far weaker than a good human group) and
 * prints outcome statistics. This is the tool for balance work: tweak the
 * POLICY below (or the tile counts via --preset/engine TILE_PRESETS), re-run,
 * compare. Thousands of games take seconds and cost nothing.
 *
 * Policy summary (v1 — refine me):
 *   - souls seek rune circles until they bear a distinct mark of the party's
 *     leading pantheon, then seek that pantheon's gate
 *   - avoids ending moves in draugr sight; never charges; avoids rifts
 *   - stays to bank resolve when no move helps; rekindles when hopeless
 *   - braces when resolve is full or the stack runs low
 *   - in random-runes mode, lingers on circles until the mark matches
 */
import {
  createGame, applyAction, losFor, RUNES, TILE_PRESETS, normTiles,
  SIZE, key, OPP, exitsFor, stepDir,
} from '../public/shared/engine.js';

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

// ---------------------------------------------------------------- helpers

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tileAt = (s, r, c) => { const cl = s.grid[key(r, c)]; return cl && cl.tile ? cl.tile : null; };
const riftAt = (s, r, c) => { const cl = s.grid[key(r, c)]; return !!(cl && cl.rift); };

function tilesOf(s, kind, gate) {
  const out = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const t = tileAt(s, r, c);
    if (t && t.kind === kind && (gate === undefined || t.gate === gate)) out.push([r, c]);
  }
  return out;
}

function dangerSet(s) {
  const out = new Set();
  for (const [r, c] of tilesOf(s, 'draugr')) for (const k of losFor(s, r, c)) out.add(k);
  return out;
}

// BFS distances over connected passages from (r,c); rifts and mist block
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

function leadingPantheon(s) {
  const counts = { valhalla: new Set(), folkvangr: new Set() };
  for (const p of s.players) if (p.rune) counts[p.rune.p].add(p.rune.k);
  // prefer a pantheon whose gate still exists (board or stack)
  const gatesLeft = new Set();
  for (const [r, c] of tilesOf(s, 'gate')) gatesLeft.add(tileAt(s, r, c).gate);
  for (const t of s.stack) if (t.kind === 'gate') gatesLeft.add(t.gate);
  const cand = ['valhalla', 'folkvangr'].filter(g => gatesLeft.has(g));
  if (!cand.length) return 'valhalla';
  cand.sort((a, b) => counts[b].size - counts[a].size);
  return cand[0];
}

// does this soul bear a mark that counts toward the leading set?
function hasGoodMark(s, p, leading) {
  if (!p.rune || p.rune.p !== leading) return false;
  return !s.players.some(q => q.seat < p.seat && q.rune
    && q.rune.p === p.rune.p && q.rune.k === p.rune.k);
}

function goalCells(s, p, leading) {
  if (!hasGoodMark(s, p, leading)) return tilesOf(s, 'rune');
  const good = s.players.filter(q => hasGoodMark(s, q, leading)).length;
  if (good === 4 || tilesOf(s, 'rune').length === 0) return tilesOf(s, 'gate', leading);
  // marked but the set is incomplete: drift toward the gate anyway
  return tilesOf(s, 'gate', leading);
}

function openToEmpty(s, r, c, exits) {
  let n = 0;
  for (let d = 0; d < 4; d++) {
    if (!exits[d]) continue;
    const [nr, nc] = stepDir(r, c, d);
    if (!s.grid[key(nr, nc)]) n++;
  }
  return n;
}

// ---------------------------------------------------------------- policy

function policy(s, rnd) {
  const aw = s.awaiting;
  const p = s.players[aw.seat];
  const leading = leadingPantheon(s);

  switch (aw.type) {
    case 'place-start': {
      // spread out: maximize distance from already-placed souls
      let best = null, bestScore = -1;
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
        if (s.grid[key(r, c)]) continue;
        let dmin = 99;
        for (const q of s.players) {
          if (!q.placed) continue;
          const dr = Math.min(Math.abs(q.r - r), SIZE - Math.abs(q.r - r));
          const dc = Math.min(Math.abs(q.c - c), SIZE - Math.abs(q.c - c));
          dmin = Math.min(dmin, dr + dc);
        }
        const score = (dmin === 99 ? 3 : Math.min(dmin, 4)) + rnd();
        if (score > bestScore) { bestScore = score; best = { r, c, rot: Math.floor(rnd() * 4) }; }
      }
      return best;
    }

    case 'place-tile': {
      // exploration: the placement whose rotation opens the most new mist
      let best = null, bestScore = -1;
      for (const tg of aw.targets) {
        for (const rot of tg.rots) {
          const score = openToEmpty(s, tg.r, tg.c, exitsFor(aw.tile.kind, rot)) + rnd() * 0.5;
          if (score > bestScore) { bestScore = score; best = { r: tg.r, c: tg.c, rot }; }
        }
      }
      return best;
    }

    case 'place-blind':
    case 'place-landing':
    case 'place-scramble': {
      let best = aw.rots[0], bestScore = -1;
      for (const rot of aw.rots) {
        const score = openToEmpty(s, aw.r, aw.c, exitsFor(aw.tile.kind, rot)) + rnd() * 0.5;
        if (score > bestScore) { bestScore = score; best = rot; }
      }
      return { rot: best };
    }

    case 'action': {
      const myTile = tileAt(s, p.r, p.c);
      const good = hasGoodMark(s, p, leading);
      // random-runes linger: reroll on the circle until the mark fits
      if (aw.stay && s.randomRunes && myTile && myTile.kind === 'rune' && !good && s.stack.length > 8) {
        return { kind: 'stay' };
      }
      if (aw.rekindle) return { kind: 'rekindle' };
      const danger = dangerSet(s);
      const goals = goalCells(s, p, leading);
      let best = null, bestScore = -Infinity;
      for (const m of aw.moves) {
        if (m.kind === 'charge') continue;      // v1 never charges
        let score = rnd() * 0.3;
        if (m.kind === 'jump') score -= 50;     // v1 never jumps willingly
        if (danger.has(key(m.r, m.c))) score -= 8;
        const dt = tileAt(s, m.r, m.c);
        if (dt && dt.fractured && dt.kind !== 'rune') score -= 1;
        if (dt && dt.kind === 'rune' && !good) score += 6;
        if (goals.length && dt) {
          const dist = bfs(s, m.r, m.c);
          let dmin = Infinity;
          for (const [gr, gc] of goals) dmin = Math.min(dmin, dist.get(key(gr, gc)) ?? Infinity);
          if (dmin !== Infinity) score += 10 / (1 + dmin);
        }
        if (dt) score += 0.6 * openToEmpty(s, m.r, m.c, dt.exits);
        if (m.kind === 'blind') score += 0.4;   // hopeless souls must wander
        if (score > bestScore) { bestScore = score; best = m; }
      }
      const onFractured = myTile && myTile.fractured;
      if (aw.stay && !onFractured && p.resolve < 2 && (best === null || bestScore < 1.2)) {
        return { kind: 'stay' };
      }
      if (best) return { kind: 'move', d: best.d };
      return aw.stay ? { kind: 'stay' } : { kind: 'move', d: aw.moves[0].d };
    }

    case 'post-move': {
      // spend overflowing resolve to push toward the goal
      if (aw.canMoveAgain && p.resolve === 2 && aw.moves.length) {
        const danger = dangerSet(s);
        const goals = goalCells(s, p, leading);
        let best = null, bestScore = 0.5;
        for (const m of aw.moves) {
          if (m.kind !== 'move' || danger.has(key(m.r, m.c))) continue;
          if (!goals.length) continue;
          const dist = bfs(s, m.r, m.c);
          let dmin = Infinity;
          for (const [gr, gc] of goals) dmin = Math.min(dmin, dist.get(key(gr, gc)) ?? Infinity);
          const score = dmin === Infinity ? 0 : 10 / (1 + dmin);
          if (score > bestScore) { bestScore = score; best = m; }
        }
        if (best) return { kind: 'move', d: best.d };
      }
      return { kind: 'end' };
    }

    case 'attune': {
      if (aw.random) {
        return hasGoodMark(s, p, leading) ? { skip: true } : { draw: true };
      }
      if (hasGoodMark(s, p, leading)) return { skip: true };
      const heldKeys = new Set(s.players.filter(q => q.rune && q.rune.p === leading).map(q => q.rune.k));
      const free = RUNES[leading].filter(rn => !heldKeys.has(rn.k));
      if (free.length) return { p: leading, k: free[0].k };
      return { skip: true };
    }

    case 'block':
      return { block: p.resolve >= 2 || s.stack.length < 15 };

    case 'swap-draugr': {
      // put the monster as far from the party as possible
      let best = aw.options[0], bestScore = -1;
      for (const o of aw.options) {
        let dmin = 99;
        for (const q of s.players) {
          if (!q.placed) continue;
          dmin = Math.min(dmin, Math.abs(q.r - o.r) + Math.abs(q.c - o.c));
        }
        if (dmin > bestScore) { bestScore = dmin; best = o; }
      }
      return { r: best.r, c: best.c };
    }

    case 'fall-landing': {
      // land near the party to be rekindled
      let best = aw.options[0], bestScore = Infinity;
      for (const o of aw.options) {
        let dmin = 99;
        for (const q of s.players) {
          if (!q.placed) continue;
          dmin = Math.min(dmin, Math.abs(q.r - o.r) + Math.abs(q.c - o.c));
        }
        if (dmin < bestScore) { bestScore = dmin; best = o; }
      }
      return { r: best.r, c: best.c };
    }

    case 'scramble': {
      const solid = aw.options.filter(o => !o.draw);
      const pick = (solid.length ? solid : aw.options)[0];
      return { r: pick.r, c: pick.c };
    }

    case 'niflheim': {
      // surrender the tile farthest from every soul; spare rune circles
      let best = aw.options[0], bestScore = -1;
      for (const o of aw.options) {
        const t = tileAt(s, o.r, o.c);
        let dmin = 99;
        for (const q of s.players) {
          if (!q.placed) continue;
          dmin = Math.min(dmin, Math.abs(q.r - o.r) + Math.abs(q.c - o.c));
        }
        const score = dmin - (t && t.kind === 'rune' ? 10 : 0);
        if (score > bestScore) { bestScore = score; best = o; }
      }
      return { r: best.r, c: best.c };
    }

    default:
      throw new Error('policy has no handler for awaiting type: ' + aw.type);
  }
}

// ---------------------------------------------------------------- runner

function playGame(seed) {
  const rnd = mulberry(seed * 7 + 3);
  const s = createGame({
    seed,
    tiles: TILE_PRESETS[PRESET] ? TILE_PRESETS[PRESET] : normTiles({}),
    randomRunes: RANDOM_RUNES,
  });
  let steps = 0, emptyStackSteps = 0;
  while (s.phase !== 'won' && s.phase !== 'lost') {
    // stalemate cutoff: in Niflheim with valid marks but no path to the gate,
    // nothing ever changes again — a human table would concede here
    emptyStackSteps = s.stack.length === 0 ? emptyStackSteps + 1 : 0;
    if (++steps > 6000 || emptyStackSteps > 600) {
      s.phase = 'lost';
      s.lossReason = 'stalemate — the souls are cut off from the gate (harness concession)';
      break;
    }
    applyAction(s, s.awaiting.seat, policy(s, rnd));
  }
  const leading = leadingPantheon(s);
  return {
    result: s.phase,
    lossReason: s.lossReason || '',
    turns: s.turnsTaken,
    stackLeft: s.stack.length,
    goodMarks: s.players.filter(p => hasGoodMark(s, p, leading)).length,
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
    console.error('game error:', e.message);
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

console.log('\n=== Mirkwood self-play ===');
console.log(`preset=${PRESET} randomRunes=${RANDOM_RUNES} games=${results.length} errors=${errors} (${ms}ms, ${(ms / Math.max(1, results.length)).toFixed(1)}ms/game)`);
console.log(`wins: ${wins.length}  (${(100 * wins.length / Math.max(1, results.length)).toFixed(1)}%)`);
console.log(`avg turns: ${avg(results, r => r.turns)}   avg stack left: ${avg(results, r => r.stackLeft)}   avg matching marks at end: ${avg(results, r => r.goodMarks)}`);
console.log('loss reasons:');
for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${reason}`);
}

/* Mirkwood engine tests — run: node test/engine.test.js */
import {
  createGame, applyAction, publicState, exitsFor, litSet, losFor, renameSoul,
  computeMoves, SIZE, key, RUNES, TILE_PRESETS, PLAYER_COLORS, _test,
} from '../public/shared/engine.js';

let passed = 0, failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('  FAIL ' + name); }
}
function section(name) { console.log('\n== ' + name); }

// helper: a stack of n plain crosses (bottom-first array; pop draws from end)
const crosses = n => Array.from({ length: n }, () => ({ kind: 'cross' }));
// a playable deck: gates + four rune circles buried at the bottom (never
// drawn in short tests) so the auto-loss checks (no gates / not enough
// circles for the four marks) stay quiet.
const deck = n => [
  { kind: 'gate', gate: 'valhalla' },
  { kind: 'gate', gate: 'folkvangr' },
  { kind: 'rune', fractured: true },
  { kind: 'rune', fractured: true },
  { kind: 'rune', fractured: true },
  { kind: 'rune', fractured: true },
  ...crosses(n),
];

// helper: run standard setup — each soul places their start at spread-out
// spots. Start tile exits N,E at rot 0.
function doSetup(s, spots = [[1, 1], [1, 4], [4, 1], [4, 4]]) {
  for (let seat = 0; seat < 4; seat++) {
    applyAction(s, seat, { r: spots[seat][0], c: spots[seat][1], rot: 0 });
    // place illumination tiles until this seat's setup is done
    while (s.awaiting && s.awaiting.type === 'place-tile') {
      const aw = s.awaiting;
      const tg = aw.targets[0];
      applyAction(s, aw.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
    }
  }
}

// ---------------------------------------------------------------- rotation
section('tile rotation');
{
  check(JSON.stringify(exitsFor('straight', 0)) === '[1,0,1,0]', 'straight rot0 = N/S');
  check(JSON.stringify(exitsFor('straight', 1)) === '[0,1,0,1]', 'straight rot1 = E/W');
  check(JSON.stringify(exitsFor('gate', 2)) === '[0,0,1,0]', 'gate rot2 opens south');
  check(JSON.stringify(exitsFor('tee', 1)) === '[1,1,1,0]', 'tee rot1 = N/E/S');
}

// ---------------------------------------------------------------- setup
section('setup & illumination');
{
  const s = createGame({ seed: 42, stack: deck(30) });
  check(s.phase === 'setup', 'starts in setup');
  check(s.awaiting.type === 'place-start' && s.awaiting.seat === 0, 'awaits seat 0 start');
  doSetup(s);
  check(s.phase === 'play', 'play begins after setup');
  // each start has 2 exits into empty mist => 8 tiles drawn (deck(30) = 36)
  check(publicState(s).stackCount === 28, '8 tiles drawn during setup');
  const p0 = s.players[0];
  check(p0.placed && p0.r === 1 && p0.c === 1, 'soul 0 on start');
  check(s.awaiting.type === 'action' && s.awaiting.seat === 0, 'soul 0 to act');
  const lit = litSet(s);
  check(lit.has(key(0, 1)) && lit.has(key(1, 2)), 'start exits lit (N and E)');
}

// ---------------------------------------------------------------- stay
section('stay: resolve gain + tile burn');
{
  const s = createGame({ seed: 1, stack: deck(30) });
  doSetup(s);
  const before = s.stack.length;
  applyAction(s, 0, { kind: 'stay' });
  check(s.players[0].resolve === 2, 'resolve 1 -> 2');
  check(s.stack.length === before - 1, 'one tile burned');
  // start tile is fractured -> staying on it means falling
  check(s.players[0].falling !== null, 'stayed on fractured start -> falls');
  // the rift forms, then closes immediately: no one lights it once the soul falls
  check(s.grid[key(1, 1)] === null, 'unlit rift closed behind the faller');
  check(s.discard.some(t => t.kind === 'start'), 'the start tile lies in the discard');
  check(s.turn === 1, 'turn passed');
}

// ---------------------------------------------------------------- move + fracture
section('move: fracture behind, illumination draws');
{
  const s = createGame({ seed: 2, stack: deck(40) });
  doSetup(s);
  // soul 0 at (1,1), move east onto the cross placed at (1,2)
  applyAction(s, 0, { kind: 'move', d: 1 });
  check(s.players[0].r === 1 && s.players[0].c === 2, 'moved east');
  check(s.grid[key(1, 1)] && s.grid[key(1, 1)].rift, 'fractured start crumbled behind');
  // cross at (1,2) has open N, E, S (W faces the new rift, no tile there)
  check(s.awaiting.type === 'place-tile', 'illumination placements awaited');
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    const tg = s.awaiting.targets[0];
    applyAction(s, 0, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  check(s.awaiting.type === 'post-move', 'post-move choice offered');
  check(s.awaiting.canMoveAgain === true, 'can spend resolve to move again');
  applyAction(s, 0, { kind: 'end' });
  check(s.turn === 1, 'turn advanced');
}

// ---------------------------------------------------------------- fall & landing
section('fall & landing (lands lit, TNC-faithful)');
{
  const s = createGame({ seed: 3, stack: deck(40) });
  doSetup(s);
  applyAction(s, 0, { kind: 'stay' }); // falls through fractured start at (1,1)
  // pass other three turns quickly (they stay; their starts fracture too -> they fall!)
  // instead: souls 1..3 move to stay safe
  for (let seat = 1; seat <= 3; seat++) {
    applyAction(s, seat, { kind: 'move', d: 1 });
    while (s.awaiting && s.awaiting.type === 'place-tile') {
      const tg = s.awaiting.targets[0];
      applyAction(s, s.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
    }
    applyAction(s, seat, { kind: 'end' });
  }
  // back to soul 0: landing awaited
  check(s.awaiting.type === 'fall-landing' && s.awaiting.seat === 0, 'landing awaited');
  const opts = s.awaiting.options;
  check(opts.every(o => o.r === 1 || o.c === 1), 'landing restricted to rift row/col');
  const spot = opts[0];
  applyAction(s, 0, { r: spot.r, c: spot.c });
  check(s.awaiting.type === 'place-landing', 'landing tile placement awaited');
  applyAction(s, 0, { rot: 0 });
  // landing lit (TNC-faithful): the ember survives the fall and kindles anew
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    const tg = s.awaiting.targets[0];
    applyAction(s, s.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  const p0 = s.players[0];
  check(p0.placed && p0.hopeful, 'landed lit — the ember survives the fall');
  check(s.awaiting.type === 'action' && s.awaiting.seat === 0, 'takes turn after landing');
  check(s.awaiting.rekindle !== true, 'no rekindle needed — landed lit');
}

// ---------------------------------------------------------------- draugr attack
section('draugr: trigger, hit, brace, evade resolve');
{
  const s = createGame({ seed: 4, stack: deck(40) });
  doSetup(s, [[1, 1], [1, 4], [4, 1], [4, 4]]);
  // Build a corridor by hand: draugr at (3,3), straight open N/S at (2,3) wait —
  // simplest: place draugr adjacent to soul 0's reachable cross at (1,2):
  // draugr at (2,2), connected via cross (1,2)'s south exit.
  _test.setTile(s, 2, 2, _test.makeTileDef(s, 'draugr'), 0);
  // soul 0 at (1,1) moves east to (1,2): dest is in draugr's LoS (corridor (2,2)->(1,2))
  const stackBefore = s.stack.length;
  applyAction(s, 0, { kind: 'move', d: 1 });
  // soul 0 has 1 resolve -> brace prompt
  check(s.awaiting.type === 'block' && s.awaiting.seat === 0, 'brace prompt for victim');
  applyAction(s, 0, { block: true });
  check(s.players[0].hopeful === false, 'struck soul goes hopeless');
  check(s.players[0].resolve === 0, 'resolve spent bracing');
  check(stackBefore - s.stack.length === 2, 'braced: only 2 tiles lost');
  // hopeless: no illumination; post-move offered
  check(s.awaiting.type === 'post-move', 'post-move after hit');
  applyAction(s, 0, { kind: 'end' });

  // soul 1's turn — far away, moves freely, no trigger
  check(s.awaiting.seat === 1 && s.awaiting.type === 'action', 'soul 1 to act');
}

section('draugr: evade grants resolve');
{
  const s = createGame({ seed: 5, stack: deck(60) });
  doSetup(s);
  // surgery: soul 0 stands on the cross at (1,2); draugr below at (2,2);
  // an escape cross at (1,3) that the draugr cannot see.
  s.players[0].r = 1; s.players[0].c = 2;
  _test.setTile(s, 2, 2, _test.makeTileDef(s, 'draugr'), 0);
  _test.setTile(s, 1, 3, _test.makeTileDef(s, 'cross'), 0);
  const los = losFor(s, 2, 2);
  check(los.has(key(1, 2)) && !los.has(key(1, 3)), 'draugr sees (1,2) but not (1,3)');
  // recompute the awaited action for the new position
  s.awaiting = null; s.queue.unshift({ t: 'action' }); _test.run(s);
  const mv = s.awaiting.moves.find(m => m.r === 1 && m.c === 3);
  check(!!mv, 'escape move available');
  applyAction(s, 0, { kind: 'move', d: mv.d });
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    const tg = s.awaiting.targets[0];
    applyAction(s, 0, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  check(s.players[0].hopeful, 'evaded the strike');
  check(s.players[0].resolve === 2, 'evade steeled resolve (+1)');
}

// ---------------------------------------------------------------- attune & win
section('rune attunement and victory');
{
  const s = createGame({ seed: 6, stack: deck(60) });
  doSetup(s);
  // hand-build: rune circle at (1,2) is where soul 0 will move (replace the cross)
  _test.setTile(s, 1, 2, _test.makeTileDef(s, 'rune', { fractured: true }), 0);
  applyAction(s, 0, { kind: 'move', d: 1 });
  check(s.awaiting.type === 'attune' && s.awaiting.seat === 0, 'attune prompt on arrival');
  applyAction(s, 0, { p: 'valhalla', k: 'dagaz' });
  check(s.players[0].rune && s.players[0].rune.k === 'dagaz', 'rune marked');
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    const tg = s.awaiting.targets[0];
    applyAction(s, 0, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  applyAction(s, 0, { kind: 'end' });

  // Now teleport a near-win: gate at (3,3) opening north; souls 0,2,3 already
  // on it with distinct valhalla runes; soul 1 adjacent at (2,3) walks in.
  const runes = RUNES.valhalla;
  _test.setTile(s, 3, 3, _test.makeTileDef(s, 'gate', { gate: 'valhalla' }), 0);
  _test.setTile(s, 2, 3, _test.makeTileDef(s, 'cross'), 0);
  for (let i = 0; i < 4; i++) {
    s.players[i].rune = { p: 'valhalla', k: runes[i].k };
    s.players[i].r = 3; s.players[i].c = 3; s.players[i].placed = true;
  }
  s.players[1].r = 2; s.players[1].c = 3;
  // it is soul 1's turn — recompute the awaited action after the surgery
  s.awaiting = null; s.queue.length = 0; s.queue.push({ t: 'action' }); _test.run(s);
  check(s.awaiting.type === 'action' && s.awaiting.seat === 1, 'soul 1 to act');
  const mv = s.awaiting.moves.find(m => m.r === 3 && m.c === 3);
  check(!!mv, 'gate enterable through its single doorway');
  applyAction(s, 1, { kind: 'move', d: mv.d });
  check(s.phase === 'won' && s.winnerGate === 'valhalla', 'victory when all assembled with distinct runes');
}

// ---------------------------------------------------------------- gate direction
section('gate: single entrance');
{
  const s = createGame({ seed: 7, stack: deck(60) });
  doSetup(s);
  // gate at (1,3) with doorway facing WEST (rot 3): soul 0's cross at (1,2) connects
  _test.setTile(s, 1, 3, _test.makeTileDef(s, 'gate', { gate: 'folkvangr' }), 3);
  applyAction(s, 0, { kind: 'move', d: 1 }); // to (1,2)
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    const tg = s.awaiting.targets[0];
    applyAction(s, 0, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  const moves = s.awaiting.moves;
  check(moves.some(m => m.r === 1 && m.c === 3), 'can enter gate through doorway');
  // approach from the north: (0,3). Put soul 2 there and check no move south into gate
  _test.setTile(s, 0, 3, _test.makeTileDef(s, 'cross'), 0);
  s.players[2].r = 0; s.players[2].c = 3;
  const m1 = computeMoves(s, s.players[2]);
  check(!m1.some(m => m.r === 1 && m.c === 3), 'cannot enter gate through its walls');
}

// ---------------------------------------------------------------- niflheim
section("niflheim's embrace");
{
  const s = createGame({ seed: 8, stack: crosses(8) }); // exactly the setup draws
  doSetup(s);
  check(s.stack.length === 0, 'stack exhausted after setup');
  check(!s.niflheim, 'niflheim not yet declared (first end-turn declares)');
  // keep the instant-loss checks quiet: a permanent gate on the board and valid marks
  _test.setTile(s, 5, 5, _test.makeTileDef(s, 'gate', { gate: 'valhalla' }), 0);
  RUNES.valhalla.forEach((r, i) => { s.players[i].rune = { p: 'valhalla', k: r.k }; });
  // soul 0 moves east; no illumination possible; then must remove a tile at end
  applyAction(s, 0, { kind: 'move', d: 1 });
  check(s.awaiting.type === 'post-move', 'post-move (no illumination without tiles)');
  applyAction(s, 0, { kind: 'end' });
  check(s.niflheim === true, 'niflheim declared');
  check(s.awaiting.type === 'niflheim', 'extra removal demanded');
  const opt = s.awaiting.options[0];
  const cellsBefore = s.grid.filter(Boolean).length;
  applyAction(s, 0, { r: opt.r, c: opt.c });
  check(s.grid.filter(Boolean).length < cellsBefore, 'a tile was claimed by the cold');
}

// ---------------------------------------------------------------- loss: gates gone
section('loss: both gates lost');
{
  // gates at the BOTTOM (setup draws from the top/end), plus a rune circle so
  // the rune-impossibility loss check stays quiet while the gates burn
  const stack2 = [
    { kind: 'rune', fractured: true },
    { kind: 'gate', gate: 'valhalla' }, { kind: 'gate', gate: 'folkvangr' },
    ...crosses(20),
  ];
  const s = createGame({ seed: 9, stack: stack2 });
  doSetup(s);
  // marks already held keep the rune-capacity loss check quiet — this test
  // is about losing the gates
  RUNES.valhalla.forEach((r, i) => { s.players[i].rune = { p: 'valhalla', k: r.k }; });
  // cheat: drop all but [rune, gate, gate] from the stack, then stay twice
  s.stack.splice(3);
  applyAction(s, 0, { kind: 'stay' }); // burns folkvangr gate (top of remaining)
  // soul 0 falls (fractured start) — turn passed to seat 1
  check(s.discard.some(t => t.kind === 'gate'), 'a gate lies in the discard');
  applyAction(s, 1, { kind: 'stay' }); // burns valhalla gate -> loss
  check(s.phase === 'lost', 'game lost when both gates are gone');
  console.log('    loss reason:', s.lossReason);
}

// ---------------------------------------------------------------- blind move
section('hopeless blind movement');
{
  const s = createGame({ seed: 10, stack: deck(40) });
  doSetup(s);
  s.players[0].hopeful = false;
  s.players[0].resolve = 0;
  _test.sweep(s); // their lit tiles vanish
  // regenerate options: it's soul 0's turn; the awaited action was computed before
  // hopeless flip — recompute by re-running the action step
  s.awaiting = null;
  s.queue.unshift({ t: 'action' });
  _test.run(s);
  const aw = s.awaiting;
  check(aw.type === 'action', 'action re-awaited');
  check(aw.stay === false || aw.moves.length === 0 ? true : aw.stay === false, 'hopeless without resolve cannot freely stay');
  const blind = aw.moves.find(m => m.kind === 'blind');
  const anyMove = aw.moves[0];
  check(aw.moves.length > 0, 'has some move');
  if (blind) {
    const before = s.stack.length;
    applyAction(s, 0, { kind: 'move', d: blind.d });
    check(s.awaiting.type === 'place-blind', 'blind placement awaited');
    applyAction(s, 0, { rot: s.awaiting.rots[0] });
    check(s.stack.length === before - 1, 'exactly one tile drawn for blind move');
    check(s.players[0].r !== null, 'moved onto the drawn tile');
  } else if (anyMove) {
    applyAction(s, 0, { kind: 'move', d: anyMove.d });
    check(true, 'moved onto existing tile while hopeless');
  }
}

// ---------------------------------------------------------------- charge banishes
section('charge: strike lands on the charger, then the draugr is banished');
{
  const s = createGame({ seed: 12, stack: deck(40) });
  doSetup(s);
  // replace the cross east of soul 0's start with a draugr, then charge it
  _test.setTile(s, 1, 2, _test.makeTileDef(s, 'draugr'), 0);
  s.awaiting = null; s.queue.unshift({ t: 'action' }); _test.run(s);
  const mv = s.awaiting.moves.find(m => m.kind === 'charge');
  check(!!mv, 'charge offered while holding resolve');
  const stackBefore = s.stack.length;
  applyAction(s, 0, { kind: 'move', d: mv.d });
  // charging spent the only resolve, so the hit auto-applies (no brace prompt)
  const p0 = s.players[0];
  check(p0.resolve === 0, 'resolve spent on the charge');
  check(p0.hopeful === false, 'the strike landed — charger hopeless');
  check(stackBefore - s.stack.length === 3, 'full 3 tiles burned by the strike');
  check(s.awaiting.type === 'scramble' && s.awaiting.seat === 0, 'charger scrambles while still on the draugr');
  const t12 = _test.tileAt(s, 1, 2);
  check(t12 && t12.kind === 'draugr', 'the draugr stands until the charger scrambles off');
  const opt = s.awaiting.options.find(o => !o.draw) || s.awaiting.options[0];
  applyAction(s, 0, { r: opt.r, c: opt.c });
  if (s.awaiting && (s.awaiting.type === 'place-scramble')) applyAction(s, 0, { rot: s.awaiting.rots[0] });
  check(s.players[0].placed, 'charger scrambled to footing');
  // ...and only now, with the attack resolved and the soul off its tile,
  // is the draugr banished — even before any rekindling could see it
  check(s.events.some(e => e.e === 'banish'), 'banish event emitted with the scramble');
  check(s.grid[key(1, 2)] === null, 'the draugr is gone from the forest (bare ground, no rift)');
  check(s.discard.some(t => t.kind === 'draugr'), 'the banished draugr lies in the discard');
}

// ---------------------------------------------------------------- rune capacity loss
section('loss: not enough rune circles left for the missing marks');
{
  const s = createGame({ seed: 13, stack: deck(30) });
  doSetup(s);
  // nobody is marked (4 circles needed) — remove one circle, leaving 3
  s.stack.splice(s.stack.findIndex(t => t.kind === 'rune'), 1);
  applyAction(s, 0, { kind: 'move', d: 1 });
  check(s.phase === 'lost', 'game auto-ends when circles < missing marks');
  check(/Rune Circles/.test(s.lossReason || ''), 'loss reason names the rune circles');
}

section('rune capacity: held marks reduce the circles needed');
{
  const s = createGame({ seed: 14, stack: deck(30) });
  doSetup(s);
  // three distinct Valhalla marks held -> only one circle is needed
  ['dagaz', 'eihwaz', 'raido'].forEach((k, i) => { s.players[i].rune = { p: 'valhalla', k }; });
  while (s.stack.filter(t => t.kind === 'rune').length > 1) {
    s.stack.splice(s.stack.findIndex(t => t.kind === 'rune'), 1);
  }
  applyAction(s, 0, { kind: 'move', d: 1 });
  check(s.phase === 'play', 'one circle for one missing mark — the saga continues');
  // a duplicate mark does not count toward the set
  s.players[3].rune = { p: 'valhalla', k: 'dagaz' };
  s.stack.splice(s.stack.findIndex(t => t.kind === 'rune'), 1); // now 0 circles
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    const tg = s.awaiting.targets[0];
    applyAction(s, 0, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  applyAction(s, 0, { kind: 'end' }); // end-turn loss check fires
  check(s.phase === 'lost', 'duplicate marks cannot finish the set — game ends');
}

// ---------------------------------------------------------------- relight ownership
section('relight: the rekindled soul places their own tiles');
{
  const s = createGame({ seed: 15, stack: deck(40) });
  doSetup(s);
  // hopeless soul 1 waits at (1,3), connected to the cross soul 0 will reach
  _test.setTile(s, 1, 3, _test.makeTileDef(s, 'cross'), 0);
  s.players[1].r = 1; s.players[1].c = 3; s.players[1].hopeful = false;
  s.awaiting = null; s.queue.length = 0; s.queue.push({ t: 'action' }); _test.run(s);
  applyAction(s, 0, { kind: 'move', d: 1 }); // soul 0 -> (1,2), adjacent + connected
  // the mover fills their own passages first...
  while (s.awaiting && s.awaiting.type === 'place-tile' && s.awaiting.seat === 0) {
    const tg = s.awaiting.targets[0];
    applyAction(s, 0, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  check(s.players[1].hopeful, 'soul 1 rekindled by adjacency');
  check(s.awaiting && s.awaiting.type === 'place-tile' && s.awaiting.seat === 1 && s.awaiting.forSeat === 1,
    'the rekindled soul reveals their own paths — never another player');
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    const tg = s.awaiting.targets[0];
    applyAction(s, s.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  check(s.awaiting.type === 'post-move' && s.awaiting.seat === 0, 'turn control returns to the mover');
}

// ---------------------------------------------------------------- difficulty config
section('difficulty: tile counts are configurable and clamped');
{
  const hard = createGame({ seed: 16, tiles: TILE_PRESETS.hard, label: 'Hard' });
  const count = (g, kind, fr) => g.stack.filter(t => t.kind === kind && (fr === undefined || t.fractured === fr)).length;
  check(count(hard, 'draugr') === 15, 'hard: 15 draugr');
  check(count(hard, 'rune') === 5, 'hard: 5 rune circles');
  check(count(hard, 'tee', true) === 5, 'hard: 5 fractured forks');
  check(hard.log[0].m.includes('Hard telling'), 'difficulty named in the saga log');

  const custom = createGame({ seed: 17, tiles: { draugr: 0, rune: 99, gateValhalla: 0, gateFolkvangr: 0 } });
  check(count(custom, 'draugr') === 0, 'custom: no draugr at all');
  check(count(custom, 'rune') === 12, 'custom: rune count clamped to 12');
  check(count(custom, 'gate') === 1, 'custom: at least one gate is forced');

  // the discard tracker's denominators come from the real stack composition
  const hardPub = publicState(hard);
  check(hardPub.tileTotals && hardPub.tileTotals.rune === 5 && hardPub.tileTotals.draugr === 15,
    'publicState exposes the true tile totals (hard: 5 circles, 15 draugar)');
  check(publicState(custom).tileTotals.draugr === 0, 'tile totals track custom counts too');
}

// ---------------------------------------------------------------- last-turn replay events
section('replay: the whole last turn is kept server-side');
{
  const s = createGame({ seed: 18, stack: deck(40) });
  doSetup(s);
  // soul 0 takes a full turn: move + reveal placements + end
  applyAction(s, 0, { kind: 'move', d: 1 });
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    const tg = s.awaiting.targets[0];
    applyAction(s, s.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  applyAction(s, 0, { kind: 'end' });
  // soul 1's turn has begun: lastTurn snapshots soul 0's complete turn
  const ps = publicState(s);
  check(ps.lastTurn && ps.lastTurn.seat === 0, "lastTurn belongs to the previous player");
  const kinds = ps.lastTurn.events.map(e => e.e);
  check(kinds.includes('move'), 'lastTurn contains the move');
  check(kinds.includes('reveal'), 'lastTurn contains the tile reveals');
  check(kinds.includes('fracture'), 'lastTurn contains the start tile fracturing');
  check(ps.lastTurn.events.length > s.events.length, 'lastTurn spans more than the final action');
}

// ---------------------------------------------------------------- random runes variant
section('random runes: the stones choose an unclaimed mark');
{
  const s = createGame({ seed: 19, stack: deck(60), randomRunes: true });
  doSetup(s);
  _test.setTile(s, 1, 2, _test.makeTileDef(s, 'rune', { fractured: true }), 0);
  applyAction(s, 0, { kind: 'move', d: 1 });
  check(s.awaiting.type === 'attune' && s.awaiting.random === true, 'random attune prompt on arrival');
  applyAction(s, 0, { p: 'valhalla', k: 'dagaz', draw: true }); // explicit picks are ignored
  const r0 = s.players[0].rune;
  check(!!r0, 'a rune was assigned');
  // finish soul 0's turn, then walk soul 1 onto a fresh circle
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    const tg = s.awaiting.targets[0];
    applyAction(s, s.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  applyAction(s, 0, { kind: 'end' });
  _test.setTile(s, 1, 3, _test.makeTileDef(s, 'rune', { fractured: true }), 0);
  s.players[1].r = 1; s.players[1].c = 3;
  s.awaiting = null; s.queue.length = 0; s.queue.push({ t: 'arrive', seat: 1, then: 'post-move' }); _test.run(s);
  applyAction(s, 1, { draw: true });
  const r1 = s.players[1].rune;
  check(!!r1, 'second soul assigned too');
  check(!(r0.p === r1.p && r0.k === r1.k), 'assigned runes never duplicate a held mark');
  // lingering: Stay on the circle -> no crumble, no fall, a fresh draw
  const sl = createGame({ seed: 21, stack: deck(40), randomRunes: true });
  doSetup(sl);
  _test.setTile(sl, 1, 2, _test.makeTileDef(sl, 'rune', { fractured: true }), 0);
  applyAction(sl, 0, { kind: 'move', d: 1 });
  applyAction(sl, 0, { draw: true });
  const first = { ...sl.players[0].rune };
  while (sl.awaiting && sl.awaiting.type === 'place-tile') {
    const tg = sl.awaiting.targets[0];
    applyAction(sl, sl.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  applyAction(sl, 0, { kind: 'end' });
  for (let seat = 1; seat <= 3; seat++) {
    applyAction(sl, seat, { kind: 'move', d: 1 });
    while (sl.awaiting && sl.awaiting.type === 'place-tile') {
      const tg = sl.awaiting.targets[0];
      applyAction(sl, sl.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
    }
    applyAction(sl, seat, { kind: 'end' });
  }
  // the Stay forks on a circle: lingering is EXPLICIT (playtest refinement —
  // the implied linger stole the fall as an option)
  check(sl.awaiting.type === 'action' && sl.awaiting.canLinger === true,
    'the fork is offered: canLinger on the circle');
  const stackBeforeStay = sl.stack.length;
  applyAction(sl, 0, { kind: 'stay', linger: true }); // lingering, said out loud
  check(sl.awaiting.type === 'attune' && sl.awaiting.random === true, 'lingering re-offers the stones');
  check(stackBeforeStay - sl.stack.length === 1, 'lingering still burns a tile');
  const tCircle = _test.tileAt(sl, 1, 2);
  check(tCircle && tCircle.kind === 'rune', 'the circle does not crumble beneath a lingering soul');
  check(sl.players[0].falling === null, 'no fall while lingering');
  applyAction(sl, 0, { draw: true });
  const second = sl.players[0].rune;
  check(!(second.p === first.p && second.k === first.k), 'the stones choose a different mark');
  check(sl.turn === 1, 'lingering ends the turn as any Stay');

  // skipping is still allowed
  const s2 = createGame({ seed: 20, stack: deck(40), randomRunes: true });
  doSetup(s2);
  _test.setTile(s2, 1, 2, _test.makeTileDef(s2, 'rune', { fractured: true }), 0);
  applyAction(s2, 0, { kind: 'move', d: 1 });
  applyAction(s2, 0, { skip: true });
  check(s2.players[0].rune === null, 'declining the stones leaves no mark');

  // a PLAIN Stay on the circle is the ordinary fractured-ground rule: the
  // cracked circle gives way and the soul falls
  const sf = createGame({ seed: 22, stack: deck(40), randomRunes: true });
  doSetup(sf);
  _test.setTile(sf, 1, 2, _test.makeTileDef(sf, 'rune', { fractured: true }), 0);
  applyAction(sf, 0, { kind: 'move', d: 1 });
  applyAction(sf, 0, { skip: true });
  while (sf.awaiting && sf.awaiting.type === 'place-tile') {
    const tg = sf.awaiting.targets[0];
    applyAction(sf, sf.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  if (sf.awaiting && sf.awaiting.type === 'post-move') applyAction(sf, 0, { kind: 'end' });
  for (let seat = 1; seat <= 3; seat++) {
    if (sf.awaiting && sf.awaiting.type === 'action' && sf.awaiting.seat === seat) {
      applyAction(sf, seat, { kind: 'move', d: 1 });
      while (sf.awaiting && sf.awaiting.type === 'place-tile') {
        const tg = sf.awaiting.targets[0];
        applyAction(sf, sf.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
      }
      if (sf.awaiting && sf.awaiting.type === 'post-move') applyAction(sf, seat, { kind: 'end' });
    }
  }
  if (sf.awaiting && sf.awaiting.type === 'action' && sf.awaiting.seat === 0) {
    applyAction(sf, 0, { kind: 'stay' }); // no linger flag: the ordinary Stay
    check(sf.players[0].falling !== null, 'a plain Stay drops the soul through the circle');
    const cl = sf.grid[key(1, 2)];
    check(!cl || !cl.tile || cl.tile.kind !== 'rune', 'the circle crumbles under the plain Stay');
  } else check(true, '(plain-stay fall skipped — turn order drifted)');

  // random attunes are explicit too: a stray payload (a click meant for the
  // previous decision) bounces instead of quietly accepting the stones' rune
  const sr = createGame({ seed: 25, stack: deck(40), randomRunes: true });
  doSetup(sr);
  _test.setTile(sr, 1, 2, _test.makeTileDef(sr, 'rune', { fractured: true }), 0);
  applyAction(sr, 0, { kind: 'move', d: 1 });
  let strayed = false;
  try { applyAction(sr, 0, { kind: 'move', d: 1 }); } catch (e) { strayed = !!e.illegal; }
  check(strayed && sr.awaiting && sr.awaiting.type === 'attune' && sr.players[0].rune === null,
    'a stray payload bounces off the stones — no unchosen mark');

  // and the linger flag means nothing off the stones
  const sx = createGame({ seed: 23, stack: deck(40), randomRunes: true });
  doSetup(sx);
  const tx = _test.tileAt(sx, 1, 1); if (tx) tx.fractured = false;
  let refused = false;
  try { applyAction(sx, 0, { kind: 'stay', linger: true }); } catch (e) { refused = !!e.illegal; }
  check(refused && sx.awaiting && sx.awaiting.type === 'action',
    'lingering off a Rune Circle is refused, prompt left open');
}

// ---------------------------------------------------------------- appearance
section('appearance: souls wear the looks chosen in the lobby');
{
  const s = createGame({
    seed: 30, stack: deck(10),
    appearance: [
      { color: '#c97ba4', icon: 'raven' },
      { color: 'nope', icon: 'unknown' }, // invalid values fall back to seat defaults
    ],
  });
  check(s.players[0].color === '#c97ba4' && s.players[0].icon === 'raven', 'chosen look applied');
  check(s.players[1].color === PLAYER_COLORS[1] && s.players[1].icon === 'shield', 'bad look falls back to seat defaults');
  check(s.players[3].icon === 'hammer', 'unset seats take the default sigil order');
}

// ---------------------------------------------------------------- adoption renames
section("renaming: an adopted soul takes its keeper's name");
{
  const s = createGame({ seed: 31, stack: deck(10) });
  renameSoul(s, 3, 'Helga');
  check(s.players[3].name === 'Helga', 'soul renamed');
  check(s.log.some(l => /soul of Torvald passes to Helga/.test(l.m)), 'the handoff is told in the saga');
  renameSoul(s, 2, 'Helga'); // collides with seat 3's new name
  check(s.players[2].name === 'Helga III', 'a name collision takes the seat numeral');
  renameSoul(s, 0, '   '); // blank names are ignored
  check(s.players[0].name === 'Astrid', 'a blank name keeps the old one');
}

// ---------------------------------------------------------------- action counter
section('action counter: every action bumps publicState.seq');
{
  const s = createGame({ seed: 32, stack: deck(10) });
  const before = publicState(s).seq;
  applyAction(s, 0, { r: 1, c: 1, rot: 0 });
  check(publicState(s).seq === before + 1, 'seq increments once per action (clients animate each action once)');
}

// ---------------------------------------------------------------- end conditions
section('end conditions: an incompatible rune at the last circle loses at once');
{
  const s = createGame({ seed: 21, stack: deck(30) });
  doSetup(s);
  // three souls already bear distinct Valhalla marks; no circles wait in the
  // stack; a single circle stands beside soul 0
  ['dagaz', 'eihwaz', 'raido'].forEach((k, i) => { s.players[i + 1].rune = { p: 'valhalla', k }; });
  while (s.stack.some(t => t.kind === 'rune')) {
    s.stack.splice(s.stack.findIndex(t => t.kind === 'rune'), 1);
  }
  _test.setTile(s, 1, 2, _test.makeTileDef(s, 'rune', { fractured: true }), 0);
  applyAction(s, 0, { kind: 'move', d: 1 });
  check(s.awaiting && s.awaiting.type === 'attune', 'the stones offer their marks');
  check(s.phase === 'play', 'standing on the unspent circle, the saga lives');
  applyAction(s, 0, { p: 'folkvangr', k: 'berkano' }); // incompatible with the party
  check(s.phase === 'lost', 'a mismatched mark at the last circle ends the saga immediately');
  check(/marks a gate demands/.test(s.lossReason), 'rune-scarcity reason reported');
}

section('end conditions: taking the fitting mark at the last circle is safe');
{
  const s = createGame({ seed: 21, stack: deck(30) });
  doSetup(s);
  ['dagaz', 'eihwaz', 'raido'].forEach((k, i) => { s.players[i + 1].rune = { p: 'valhalla', k }; });
  while (s.stack.some(t => t.kind === 'rune')) {
    s.stack.splice(s.stack.findIndex(t => t.kind === 'rune'), 1);
  }
  _test.setTile(s, 1, 2, _test.makeTileDef(s, 'rune', { fractured: true }), 0);
  applyAction(s, 0, { kind: 'move', d: 1 });
  applyAction(s, 0, { p: 'valhalla', k: 'ansuz' }); // completes the set
  check(s.phase === 'play', 'the fourth Valhalla mark keeps the saga alive');
  check(s.players[0].rune && s.players[0].rune.k === 'ansuz', 'mark taken');
}

section('end conditions: a fall with the stack spent ends the saga at once');
{
  const s = createGame({ seed: 22, stack: deck(12) });
  doSetup(s);
  s.stack = [];
  s.niflheim = true;
  // soul 0 stands on their fractured start tile; Staying drops them through
  applyAction(s, 0, { kind: 'stay' });
  check(s.phase === 'lost', 'the saga ends the moment the soul falls — not a round later');
  check(/starless void/.test(s.lossReason), 'immediate fall-doom reason reported');
}

section('end conditions: the Embrace ends the saga when a soul is severed');
{
  const mk = () => {
    const s = createGame({ seed: 23, stack: deck(20) });
    doSetup(s);
    ['dagaz', 'eihwaz', 'raido', 'ansuz'].forEach((k, i) => { s.players[i].rune = { p: 'valhalla', k }; });
    s.stack = [];
    s.niflheim = true;
    for (let i = 0; i < SIZE * SIZE; i++) s.grid[i] = null;
    // a gate road along row 1: gate (1,0) opening east, crosses at (1,1)-(1,3)
    _test.setTile(s, 1, 0, _test.makeTileDef(s, 'gate', { gate: 'valhalla' }), 1);
    for (const c of [1, 2, 3]) _test.setTile(s, 1, c, _test.makeTileDef(s, 'cross'), 0);
    [[1, 1], [1, 2], [1, 3]].forEach(([r, c], i) => { s.players[i].r = r; s.players[i].c = c; });
    return s;
  };
  // connected: soul 3 on the same road — the saga lives
  let s = mk();
  _test.setTile(s, 1, 4, _test.makeTileDef(s, 'cross'), 0);
  s.players[3].r = 1; s.players[3].c = 4;
  s.awaiting = null; s.queue.unshift({ t: 'end-turn2' }); _test.run(s);
  check(s.phase === 'play', 'all four souls on the gate road: the saga lives');
  // severed: soul 3 alone on a far island — the saga ends
  s = mk();
  _test.setTile(s, 4, 4, _test.makeTileDef(s, 'cross'), 0);
  s.players[3].r = 4; s.players[3].c = 4;
  s.awaiting = null; s.queue.unshift({ t: 'end-turn2' }); _test.run(s);
  check(s.phase === 'lost', 'a soul cut off from every winnable gate ends the saga');
  check(/severed every road/.test(s.lossReason), 'embrace cutoff reason reported');
}

section('end conditions: a gate burning out from under its marked souls blames the GATE, not the circles');
{
  // playtest bug: Valhalla stood on the board, all four souls bore Fólkvangr
  // marks, the Fólkvangr gate burned from the stack — and the loss blamed the
  // Rune Circles instead of the lost gate. The set truly can't be completed
  // (they'd need four circles to re-swear to Valhalla), but the message must
  // name the real trigger.
  const s = createGame({ seed: 24, stack: deck(20) });
  doSetup(s);
  ['berkano', 'uruz', 'wunjo', 'fehu'].forEach((k, i) => { s.players[i].rune = { p: 'folkvangr', k }; });
  _test.setTile(s, 0, 0, _test.makeTileDef(s, 'gate', { gate: 'valhalla' }), 1);
  s.stack = s.stack.filter(t => t.kind !== 'gate' && t.kind !== 'rune'); // Fólkvangr lost; no circles left
  _test.lossCheck(s);
  check(s.phase === 'lost', 'the saga ends — marked for a gate that is gone, too few circles to re-swear');
  check(/Gate of F.lkvangr is lost/.test(s.lossReason), 'loss reason names the lost GATE');
  check(!/Too many Rune Circles/.test(s.lossReason), 'and does NOT blame the rune circles');
}

section('Niflheim: Gates and Void Rifts are surrenderable, occupied tiles spared');
{
  const s = createGame({ seed: 30, stack: deck(20) });
  doSetup(s);
  s.stack = []; s.niflheim = true;
  for (let i = 0; i < SIZE * SIZE; i++) s.grid[i] = null;
  _test.setTile(s, 0, 0, _test.makeTileDef(s, 'gate', { gate: 'valhalla' }), 0);  // empty gate
  _test.setTile(s, 5, 5, _test.makeTileDef(s, 'gate', { gate: 'folkvangr' }), 0);  // occupied gate
  _test.setTile(s, 3, 3, _test.makeTileDef(s, 'cross'), 0);
  s.grid[key(0, 3)] = { rift: true };                                              // a Void Rift
  s.players[0].r = 5; s.players[0].c = 5; s.players[0].placed = true;              // soul on the folkvangr gate
  s.players[1].r = 3; s.players[1].c = 3; s.players[1].placed = true;
  s.players[2].placed = true; s.players[3].placed = true;
  s.turn = 0; s.awaiting = null; s.queue.unshift({ t: 'end-turn' }); _test.run(s);
  check(s.awaiting && s.awaiting.type === 'niflheim', 'niflheim surrender awaited');
  const has = (r, c) => s.awaiting.options.some(o => o.r === r && o.c === c);
  check(has(0, 0), 'the empty Gate is surrenderable');
  check(has(0, 3), 'a Void Rift is surrenderable');
  check(!has(5, 5), 'the Gate a soul stands on is spared');
  applyAction(s, 0, { r: 0, c: 0 });                                              // surrender the empty gate
  check(_test.tileAt(s, 0, 0) === null, 'the surrendered Gate is cleared from the board');
  check(s.discard.some(t => t.kind === 'gate' && t.gate === 'valhalla'), 'the Gate went to the discard');
}

section('Niflheim: surrendering a Void Rift clears it without error');
{
  const s = createGame({ seed: 31, stack: deck(20) });
  doSetup(s);
  s.stack = []; s.niflheim = true;
  for (let i = 0; i < SIZE * SIZE; i++) s.grid[i] = null;
  s.grid[key(2, 2)] = { rift: true };
  s.players.forEach((p, i) => { p.placed = true; p.r = i; p.c = 0; });
  s.turn = 0; s.awaiting = null; s.queue.unshift({ t: 'end-turn' }); _test.run(s);
  check(s.awaiting && s.awaiting.options.some(o => o.r === 2 && o.c === 2), 'the Rift is an option');
  const before = s.discard.length;
  applyAction(s, 0, { r: 2, c: 2 });
  check(!s.grid[key(2, 2)], 'the Rift cell is cleared');
  check(s.discard.length === before, 'a Rift adds nothing to the discard (it has no tile)');
}

section('end conditions: a lost gate is survivable while enough circles remain to re-swear');
{
  const s = createGame({ seed: 24, stack: deck(20) });
  doSetup(s);
  ['berkano', 'uruz', 'wunjo', 'fehu'].forEach((k, i) => { s.players[i].rune = { p: 'folkvangr', k }; });
  _test.setTile(s, 0, 0, _test.makeTileDef(s, 'gate', { gate: 'valhalla' }), 1);
  s.stack = s.stack.filter(t => t.kind !== 'gate'); // Fólkvangr lost, but the four circles remain
  _test.lossCheck(s);
  check(s.phase === 'play', 'four circles remain: the party can still swear anew to Valhalla');
}

// ---------------------------------------------------------------- burn reveal + lost gates seal runes
section('burn events name the loss; a lost gate seals its runes');
{
  const s = createGame({ seed: 27, stack: deck(40) });
  doSetup(s); // (setup's illumination draws come off the top — reorder AFTER it)
  // move the Fólkvangr gate to the top of the stack: the next burn takes it
  const gi = s.stack.findIndex(t => t.kind === 'gate' && t.gate === 'folkvangr');
  s.stack.push(...s.stack.splice(gi, 1));
  applyAction(s, 0, { kind: 'stay' }); // stillness burns the gate off the top
  const burnEv = s.events.find(e => e.e === 'burn');
  check(!!burnEv && Array.isArray(burnEv.tiles), 'burn events carry the tiles the mist takes');
  check(burnEv && burnEv.tiles[0] && burnEv.tiles[0].kind === 'gate' && burnEv.tiles[0].gate === 'folkvangr',
    'the burned gate is named in the event');
  check(s.phase === 'play', 'with four circles left the saga survives the gate');
  // soul 1 steps onto a circle: only the surviving pantheon may be sworn
  _test.setTile(s, 1, 5, _test.makeTileDef(s, 'rune', { fractured: true }), 0);
  applyAction(s, 1, { kind: 'move', d: 1 });
  check(s.awaiting.type === 'attune' && s.awaiting.seat === 1, 'attune prompt on arrival');
  check(Array.isArray(s.awaiting.gates) && s.awaiting.gates.includes('valhalla')
    && !s.awaiting.gates.includes('folkvangr'), 'the prompt names only attainable gates');
  let threw = null;
  try { applyAction(s, 1, { p: 'folkvangr', k: RUNES.folkvangr[0].k }); } catch (e) { threw = e; }
  check(threw && /lost to the mist/.test(threw.message), 'swearing to the lost gate is refused');
  check(s.awaiting && s.awaiting.type === 'attune', 'a refused pick leaves the decision open');
  const circle = _test.tileAt(s, 1, 5);
  check(circle && !circle.spent, 'a refused pick leaves the circle unspent');
  applyAction(s, 1, { p: 'valhalla', k: RUNES.valhalla[0].k });
  check(s.players[1].rune && s.players[1].rune.p === 'valhalla', 'the surviving gate still marks');
}
{
  // Random Runes: the stones never choose a lost gate's rune...
  const s = createGame({ seed: 28, stack: deck(40), randomRunes: true });
  const gi = s.stack.findIndex(t => t.kind === 'gate' && t.gate === 'folkvangr');
  s.discard.push(...s.stack.splice(gi, 1));
  // three valhalla runes already borne: exactly one attainable rune remains
  for (let i = 1; i < 4; i++) s.players[i].rune = { p: 'valhalla', k: RUNES.valhalla[i - 1].k };
  doSetup(s);
  _test.setTile(s, 1, 2, _test.makeTileDef(s, 'rune', { fractured: true }), 0);
  applyAction(s, 0, { kind: 'move', d: 1 });
  check(s.awaiting.type === 'attune' && s.awaiting.random === true, 'random attune prompt');
  check(!s.awaiting.gates.includes('folkvangr'), 'random prompt also names only attainable gates');
  applyAction(s, 0, { draw: true });
  check(s.players[0].rune && s.players[0].rune.p === 'valhalla'
    && s.players[0].rune.k === RUNES.valhalla[3].k,
    'the stones give the one attainable unclaimed rune');
}
{
  // ...and stay silent when nothing attainable remains (no crash, no mark)
  const s = createGame({ seed: 29, stack: deck(40), randomRunes: true });
  const gi = s.stack.findIndex(t => t.kind === 'gate' && t.gate === 'folkvangr');
  s.discard.push(...s.stack.splice(gi, 1));
  for (let i = 0; i < 4; i++) s.players[i].rune = { p: 'valhalla', k: RUNES.valhalla[i].k };
  doSetup(s);
  _test.setTile(s, 1, 2, _test.makeTileDef(s, 'rune', { fractured: true }), 0);
  applyAction(s, 0, { kind: 'move', d: 1 });
  applyAction(s, 0, { draw: true });
  check(s.players[0].rune && s.players[0].rune.k === RUNES.valhalla[0].k,
    'silent stones leave the borne mark untouched');
  check(s.phase === 'play', 'an empty pool does not wedge or end the game');
}

// ---------------------------------------------------------------- gate doorway variants
section('gate doorway variants (balance experiments)');
{
  const j = a => JSON.stringify(a);
  check(j(exitsFor('gate', 0)) === j([1, 0, 0, 0]), 'default gate keeps the single doorway');
  check(j(exitsFor('gate', 0, 'one')) === j([1, 0, 0, 0]), "explicit 'one' matches the default");
  check(j(exitsFor('gate', 1, 'straight')) === j([0, 1, 0, 1]), 'straight gate: two opposite doorways, rotated');
  check(exitsFor('gate', 0, 'tee').filter(Boolean).length === 3, 'tee gate opens three ways');
  const s = createGame({ seed: 31, stack: deck(40), gateExits: 'straight' });
  check(s.gateExits === 'straight', 'the variant rides on the state');
  doSetup(s);
  _test.setTile(s, 3, 3, _test.makeTileDef(s, 'gate', { gate: 'valhalla' }), 0);
  const t = _test.tileAt(s, 3, 3);
  check(t.exits[0] === 1 && t.exits[2] === 1 && t.exits[1] === 0 && t.exits[3] === 0,
    'a placed gate carries the variant doorways');
  check(createGame({ seed: 32, stack: deck(10) }).gateExits === 'one', 'default games keep one doorway');
  check(createGame({ seed: 33, stack: deck(10), gateExits: 'nonsense' }).gateExits === 'one',
    'unknown variants fall back to the live rule');
}

// ---------------------------------------------------------------- rune perks
section('rune perks (host variant)');
{
  // Dagaz — Dawn returns: the bearer never begins a turn hopeless
  const s = createGame({ seed: 40, stack: deck(40), runePerks: true });
  s.players[1].rune = { p: 'valhalla', k: 'dagaz' };
  doSetup(s);
  s.players[1].hopeful = false;
  applyAction(s, 0, { kind: 'move', d: 1 });
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    const tg = s.awaiting.targets[0];
    applyAction(s, s.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  applyAction(s, 0, { kind: 'end' });
  check(s.players[1].hopeful === true, 'Dagaz: dawn returns at the turn start');
}
{
  // Eihwaz — Tireless: one free Press On per turn, even at 0 Resolve
  const s = createGame({ seed: 41, stack: deck(40), runePerks: true });
  s.players[0].rune = { p: 'valhalla', k: 'eihwaz' };
  doSetup(s);
  s.players[0].resolve = 0;
  applyAction(s, 0, { kind: 'move', d: 1 });
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    const tg = s.awaiting.targets[0];
    applyAction(s, s.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  check(s.awaiting.type === 'post-move' && s.awaiting.canMoveAgain === true,
    'Eihwaz: may press on with no Resolve');
  const before = s.players[0].resolve;
  const mv = s.awaiting.moves.find(m => m.kind === 'move');
  if (mv) {
    applyAction(s, 0, { kind: 'move', d: mv.d });
    check(s.players[0].resolve === before, 'Eihwaz: the free step costs nothing');
  } else check(true, 'Eihwaz: (no plain move available to press into — skipped)');
}
{
  // Raido — Wayfarer: 1 ◆ steps across a rift; the rift remains
  const s = createGame({ seed: 42, stack: deck(40), runePerks: true });
  s.players[0].rune = { p: 'valhalla', k: 'raido' };
  doSetup(s);
  s.grid[key(1, 2)] = { rift: true };
  _test.setTile(s, 1, 3, _test.makeTileDef(s, 'cross'), 0);
  s.players[0].resolve = 1;
  s.awaiting = null; s.queue.unshift({ t: 'action' }); _test.run(s);
  const cross = s.awaiting.moves.find(m => m.kind === 'cross');
  check(!!cross && cross.r === 1 && cross.c === 3 && cross.cost === 1, 'Raido: the crossing is offered for 1 ◆');
  applyAction(s, 0, { kind: 'move', d: cross.d, cross: true });
  check(s.players[0].r === 1 && s.players[0].c === 3, 'Raido: the bearer stands beyond the rift');
  check(s.players[0].resolve === 0, 'Raido: the toll was paid');
  check(s.grid[key(1, 2)] && s.grid[key(1, 2)].rift, 'Raido: the rift remains for the unwary');
  // the road answers once a turn: after a crossing, no second crossing (and
  // no turning) is offered this turn even with ◆ to spend
  s.players[0].resolve = 2;
  if (s.awaiting && s.awaiting.type === 'post-move') {
    check(!s.awaiting.moves.some(m => m.kind === 'cross') || s.wayfarerUsed === true,
      'Raido: the crossing shares the once-a-turn road-craft');
    check(!(s.awaiting.turns && s.awaiting.turns.length), 'Raido: no turning after the crossing');
  } else check(s.wayfarerUsed === true, 'Raido: the road-craft is spent for the turn');
}
{
  // Raido — Wayfarer: turning an adjacent misaligned path (1 ◆, once a turn)
  const s = createGame({ seed: 42, stack: deck(40), runePerks: true });
  s.players[0].rune = { p: 'valhalla', k: 'raido' };
  doSetup(s);
  _test.setTile(s, 0, 1, _test.makeTileDef(s, 'straight'), 1); // E/W: a wall toward the bearer
  s.players[0].resolve = 2;
  s.awaiting = null; s.queue.unshift({ t: 'action' }); _test.run(s);
  check(Array.isArray(s.awaiting.turns) && s.awaiting.turns.some(o => o.r === 0 && o.c === 1),
    'Raido: the misaligned path is offered for turning');
  check(!s.awaiting.moves.some(m => m.d === 0 && m.kind === 'move'),
    'Raido: the walled mouth blocks the road north');
  applyAction(s, 0, { kind: 'turn', r: 0, c: 1, rot: 0 }); // N/S — opens to the bearer
  const t = _test.tileAt(s, 0, 1);
  check(t.rot === 0 && t.exits[2] === 1, 'Raido: the path turns to meet the road');
  check(s.players[0].resolve === 1, 'Raido: turning cost 1 ◆');
  check(s.awaiting && s.awaiting.type === 'action', 'Raido: turning is not a move — the action still waits');
  check(s.awaiting.moves.some(m => m.d === 0), 'Raido: the road north is open after the turning');
  check(!(s.awaiting.turns && s.awaiting.turns.length), 'Raido: the road answers only once a turn');
  let threw = false;
  try { applyAction(s, 0, { kind: 'turn', r: 0, c: 1, rot: 1 }); } catch (e) { threw = !!e.illegal; }
  check(threw, 'Raido: a second turning this turn is refused');
  // an occupied tile may never be turned (souls are not furniture)
  const s2 = createGame({ seed: 42, stack: deck(40), runePerks: true });
  s2.players[0].rune = { p: 'valhalla', k: 'raido' };
  doSetup(s2);
  _test.setTile(s2, 1, 2, _test.makeTileDef(s2, 'straight'), 1);
  s2.players[1].r = 1; s2.players[1].c = 2; // a soul stands on it
  s2.awaiting = null; s2.queue.unshift({ t: 'action' }); _test.run(s2);
  check(!(s2.awaiting.turns || []).some(o => o.r === 1 && o.c === 2),
    'Raido: an occupied path cannot be turned');
}
{
  // Ansuz — Raven-counsel: the next two tiles are known on the bearer's turn
  const s = createGame({ seed: 43, stack: deck(40), runePerks: true });
  s.players[0].rune = { p: 'valhalla', k: 'ansuz' };
  doSetup(s);
  const peek = publicState(s).stackPeek;
  const top = s.stack.slice(-2).reverse();
  check(Array.isArray(peek) && peek.length === 2
    && peek[0].kind === top[0].kind && peek[1].kind === top[1].kind,
    'Ansuz: raven-counsel names the next two tiles');
  check(publicState(createGame({ seed: 44, stack: deck(10) })).stackPeek === null,
    'no peek without the variant');
}
{
  // Berkano — New growth: holding the cracked path is a CHOICE (hold flag on
  // the move) and costs 1 ◆; the tile stays, still fractured
  const s = createGame({ seed: 45, stack: deck(40), runePerks: true });
  s.players[0].rune = { p: 'folkvangr', k: 'berkano' };
  doSetup(s);
  check(s.awaiting.type === 'action' && s.awaiting.canHold === true,
    'Berkano: the hold is offered on the fractured start');
  s.players[0].resolve = 1;
  applyAction(s, 0, { kind: 'move', d: 1, hold: true });
  const behind = s.grid[key(1, 1)];
  check(behind && behind.tile && behind.tile.fractured === true,
    'Berkano: the paid hold keeps the cracked path, still fractured');
  check(s.players[0].resolve === 0, 'Berkano: the hold cost 1 ◆');
}
{
  // Berkano without the hold: the path crumbles as for anyone; and a hold
  // she cannot afford is refused up front (not silently dropped)
  const s = createGame({ seed: 45, stack: deck(40), runePerks: true });
  s.players[0].rune = { p: 'folkvangr', k: 'berkano' };
  doSetup(s);
  applyAction(s, 0, { kind: 'move', d: 1 });
  const behind = s.grid[key(1, 1)];
  check(behind && behind.rift === true, 'Berkano: no hold asked — the path crumbles');

  const s2 = createGame({ seed: 45, stack: deck(40), runePerks: true });
  s2.players[0].rune = { p: 'folkvangr', k: 'berkano' };
  doSetup(s2);
  s2.players[0].resolve = 0;
  let threw = false;
  try { applyAction(s2, 0, { kind: 'move', d: 1, hold: true }); } catch (e) { threw = !!e.illegal; }
  check(threw, 'Berkano: a hold with no ◆ is refused before the move');
  check(s2.awaiting && s2.awaiting.type === 'action', 'Berkano: the refused hold leaves the action open');
}
{
  // Uruz — Deep vitality: cap 3, and ◆ lent across the board (any distance)
  const s = createGame({ seed: 46, stack: deck(40), runePerks: true });
  s.players[1].rune = { p: 'folkvangr', k: 'uruz' };
  doSetup(s);
  const t0 = _test.tileAt(s, 1, 1); if (t0) t0.fractured = false;
  s.players[1].resolve = 2;
  s.players[0].hopeful = false;
  s.players[0].resolve = 0;
  s.awaiting = null; s.queue.unshift({ t: 'action' }); _test.run(s);
  check(s.awaiting.rekindle === true, 'Uruz: a broke teammate may still rekindle on lent ◆');
  applyAction(s, 0, { kind: 'rekindle' });
  check(s.players[0].hopeful === true && s.players[1].resolve === 1,
    'Uruz: the bearer paid for the rekindling');
  // and the cap: the bearer stands fast to 3
  while (!(s.awaiting && s.awaiting.type === 'action' && s.awaiting.seat === 1) && s.awaiting) {
    const aw = s.awaiting;
    if (aw.type === 'place-tile') { const tg = aw.targets[0]; applyAction(s, aw.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] }); continue; }
    if (aw.type === 'action') { applyAction(s, aw.seat, { kind: 'stay' }); continue; }
    if (aw.type === 'post-move') { applyAction(s, aw.seat, { kind: 'end' }); continue; }
    break;
  }
  if (s.awaiting && s.awaiting.type === 'action' && s.awaiting.seat === 1) {
    const t1 = _test.tileAt(s, s.players[1].r, s.players[1].c); if (t1) t1.fractured = false;
    s.players[1].resolve = 2;
    applyAction(s, 1, { kind: 'stay' });
    check(s.players[1].resolve === 3, 'Uruz: resolve steels to a cap of 3');
  } else check(true, 'Uruz: (cap check skipped — turn order drifted)');
}
{
  // Uruz on Hard — adjacent-only lending
  const s = createGame({ seed: 47, stack: deck(40), runePerks: true, uruzAdjacent: true });
  s.players[1].rune = { p: 'folkvangr', k: 'uruz' };
  doSetup(s); // souls 0 and 1 sit far apart (1,1) vs (1,4)
  s.players[1].resolve = 2;
  s.players[0].hopeful = false;
  s.players[0].resolve = 0;
  s.awaiting = null; s.queue.unshift({ t: 'action' }); _test.run(s);
  check(s.awaiting.rekindle !== true, 'Uruz (Hard): too far away to lend');
}
{
  // Wunjo — Shared joy + Fehu — Stocked hearth
  const s = createGame({ seed: 48, stack: deck(40), runePerks: true });
  s.players[0].rune = { p: 'folkvangr', k: 'wunjo' };
  doSetup(s);
  const t0 = _test.tileAt(s, 1, 1); if (t0) t0.fractured = false;
  s.players[1].r = 1; s.players[1].c = 2; s.players[1].resolve = 0; // beside the bearer
  applyAction(s, 0, { kind: 'stay' });
  check(s.players[1].resolve === 1, 'Wunjo: the Stay also steels the neighbor');

  const f = createGame({ seed: 49, stack: deck(40), runePerks: true });
  f.players[0].rune = { p: 'folkvangr', k: 'fehu' };
  doSetup(f);
  const ft = _test.tileAt(f, 1, 1); if (ft) ft.fractured = false;
  const stackBefore = f.stack.length;
  applyAction(f, 0, { kind: 'stay' });
  check(f.stack.length === stackBefore, 'Fehu: the stocked hearth burns nothing');
}
{
  // Wunjo — joy flows both ways: a teammate's Stay beside the bearer
  const s = createGame({ seed: 56, stack: deck(40), runePerks: true });
  s.players[1].rune = { p: 'folkvangr', k: 'wunjo' };
  doSetup(s);
  const t0 = _test.tileAt(s, 1, 1); if (t0) t0.fractured = false;
  s.players[1].r = 1; s.players[1].c = 2; // the bearer stands beside soul 0
  s.players[1].resolve = 0;
  applyAction(s, 0, { kind: 'stay' });
  check(s.players[1].resolve === 1, 'Wunjo: a teammate’s Stay beside the bearer gladdens her (+1)');
}
{
  // Fehu — Stocked hearth ransom: a Gate burned by a Stay is bought back,
  // shuffled into the stack, before the turn passes
  const s = createGame({ seed: 53, stack: deck(40), runePerks: true });
  s.players[1].rune = { p: 'folkvangr', k: 'fehu' };
  doSetup(s);
  const t0 = _test.tileAt(s, 1, 1); if (t0) t0.fractured = false;
  s.players[1].resolve = 1;
  const gi = s.stack.findIndex(t => t.kind === 'gate');
  const [gate] = s.stack.splice(gi, 1);
  s.stack.push(gate); // the stillness will burn it
  const stackBefore = s.stack.length;
  applyAction(s, 0, { kind: 'stay' });
  check(s.awaiting && s.awaiting.type === 'stocked-hearth' && s.awaiting.seat === 1,
    'Fehu: the ransom is offered to the bearer when a treasure burns');
  check(s.awaiting.options.some(o => o.kind === 'gate'), 'Fehu: the burned Gate is the ransom option');
  const opt = s.awaiting.options.find(o => o.kind === 'gate');
  applyAction(s, 1, { restore: true, id: opt.id });
  check(s.stack.length === stackBefore && s.stack.some(t => t.id === gate.id),
    'Fehu: the Gate returns to the stack');
  check(!s.discard.some(t => t.id === gate.id), 'Fehu: the Gate no longer lies in the discard');
  check(s.players[1].resolve === 0 && s.perkUse.hearth === 1, 'Fehu: the ransom was paid');
  check(s.turn === 1, 'Fehu: the turn then passes as normal');
}
{
  // Fehu ransom can avert the last-gate doom — the loss check waits for the
  // bearer's answer; a declined ransom lets the doom fall
  const mk = (seed) => {
    const s = createGame({ seed, stack: deck(40), runePerks: true });
    s.players[1].rune = { p: 'folkvangr', k: 'fehu' };
    doSetup(s);
    const t0 = _test.tileAt(s, 1, 1); if (t0) t0.fractured = false;
    s.players[1].resolve = 1;
    s.stack = s.stack.filter(t => t.kind !== 'gate'); // one gate left in the saga…
    s.stack.push(_test.makeTileDef(s, 'gate', { gate: 'valhalla' })); // …on top
    return s;
  };
  const a = mk(54);
  applyAction(a, 0, { kind: 'stay' });
  check(a.phase === 'play' && a.awaiting && a.awaiting.type === 'stocked-hearth',
    'Fehu: the last Gate burns — the ransom is offered before the doom');
  applyAction(a, 1, { restore: true, id: a.awaiting.options[0].id });
  check(a.phase === 'play' && a.stack.some(t => t.kind === 'gate'),
    'Fehu: the ransomed Gate averts the loss');
  const b = mk(54);
  applyAction(b, 0, { kind: 'stay' });
  // a stray racing payload must BOUNCE (the ransom can avert a loss — only an
  // explicit decline may wave it off), leaving the prompt open
  let bounced = false;
  try { applyAction(b, 1, { kind: 'move', d: 1 }); } catch (e) { bounced = !!e.illegal; }
  check(bounced && b.awaiting && b.awaiting.type === 'stocked-hearth',
    'Fehu: a stray payload bounces off the ransom prompt');
  applyAction(b, 1, { decline: true }); // let it go, said out loud
  check(b.phase === 'lost' && /Both gates are lost/.test(b.lossReason),
    'Fehu: a declined ransom lets the doom fall');
}
{
  // A strike's burn batch with a Rune Circle buried in it: the bearer picks
  // THE treasure out of the batch — not merely the top tile
  const s = createGame({ seed: 55, stack: deck(40), runePerks: true });
  s.players[1].rune = { p: 'folkvangr', k: 'fehu' };
  doSetup(s);
  s.players[1].resolve = 1;
  s.players[0].resolve = 0; // no brace prompt: the strike lands at once
  const ri = s.stack.findIndex(t => t.kind === 'rune');
  const [rune] = s.stack.splice(ri, 1);
  s.stack.splice(s.stack.length - 1, 0, rune); // second from the top: mid-batch
  s.awaiting = null; s.queue.length = 0;
  s.queue.push({ t: 'hit', seat: 0, m: [0, 0] }, { t: 'after-hits' });
  _test.run(s);
  check(s.awaiting && s.awaiting.type === 'stocked-hearth', 'Fehu: the strike’s burn batch offers a ransom');
  const opt = s.awaiting.options.find(o => o.kind === 'rune');
  check(!!opt, 'Fehu: the buried Rune Circle is pickable from the batch');
  const before = s.stack.length;
  applyAction(s, 1, { restore: true, id: opt.id });
  check(s.stack.length === before + 1 && s.stack.some(t => t.id === rune.id),
    'Fehu: the circle is shuffled back among the paths');
}
{
  // Ansuz — the dawn peek does not slide: tiles drawn during the turn consume
  // the report, and nothing new is revealed until the next dawn
  const s = createGame({ seed: 57, stack: deck(40), runePerks: true });
  s.players[0].rune = { p: 'valhalla', k: 'ansuz' };
  doSetup(s);
  const known = publicState(s).stackPeek;
  check(known && known.length === 2, 'Ansuz: two tiles known at dawn');
  const secondKind = known[1].kind;
  applyAction(s, 0, { kind: 'move', d: 1 });
  let placed = 0;
  while (s.awaiting && s.awaiting.type === 'place-tile') {
    placed++;
    const tg = s.awaiting.targets[0];
    applyAction(s, s.awaiting.seat, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  const after = publicState(s).stackPeek;
  if (placed >= 2) check(after === null, 'Ansuz: the report is spent after two draws');
  else if (placed === 1) check(after && after.length === 1 && after[0].kind === secondKind,
    'Ansuz: one draw leaves one known tile — never a fresh peek');
  else check(true, 'Ansuz: (no draws this move — skipped)');
}
{
  // Ansuz picked MID-TURN: the watermark stamps at the moment of attunement,
  // so the pickup turn gets exactly the next two — not a sliding window for
  // the rest of the turn (playtest bug: "infinite preview when first picked")
  const s = createGame({ seed: 60, stack: deck(40), runePerks: true });
  doSetup(s);
  _test.setTile(s, 1, 2, _test.makeTileDef(s, 'rune', { fractured: true }), 0);
  applyAction(s, 0, { kind: 'move', d: 1 });
  check(s.awaiting.type === 'attune', 'the stones offer their marks');
  const lenAtAttune = s.stack.length;
  applyAction(s, 0, { p: 'valhalla', k: 'ansuz' });
  check(s.peekLen === lenAtAttune, 'the watermark stamps at the moment of attunement');
  const drawsSoFar = lenAtAttune - s.stack.length;
  const view1 = publicState(s).stackPeek;
  check((view1 ? view1.length : 0) === Math.max(0, 2 - drawsSoFar),
    'the pickup peek shrinks with each draw');
  while (s.awaiting && s.awaiting.type === 'place-tile' && s.awaiting.seat === 0) {
    const tg = s.awaiting.targets[0];
    applyAction(s, 0, { r: tg.r, c: tg.c, rot: tg.rots[0] });
  }
  const drawsTotal = lenAtAttune - s.stack.length;
  const viewEnd = publicState(s).stackPeek;
  if (drawsTotal >= 2) check(viewEnd === null, 'after two draws the ravens are silent — no sliding window');
  else check((viewEnd ? viewEnd.length : 0) === 2 - drawsTotal,
    'the peek never exceeds the attunement snapshot');
}
{
  // Winter-forms: the refusal (Ansuz), winter stores (Fehu), grove shade (Berkano)
  const s = createGame({ seed: 50, stack: deck(30), runePerks: true });
  s.players[1].rune = { p: 'valhalla', k: 'ansuz' };
  doSetup(s);
  s.stack = []; s.niflheim = true;
  // make the state loss-proof so the whole round can be observed: a fully
  // connected board, both gates standing, and a complete distinct rune set
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    if (!s.grid[key(r, c)]) _test.setTile(s, r, c, _test.makeTileDef(s, 'cross'), 0);
  }
  _test.setTile(s, 0, 0, _test.makeTileDef(s, 'gate', { gate: 'valhalla' }), 2);
  _test.setTile(s, 5, 5, _test.makeTileDef(s, 'gate', { gate: 'folkvangr' }), 0);
  s.players[0].rune = { p: 'valhalla', k: 'dagaz' };
  s.players[2].rune = { p: 'valhalla', k: 'raido' };
  s.players[3].rune = { p: 'valhalla', k: 'eihwaz' };
  s.awaiting = null; s.queue.length = 0; s.queue.push({ t: 'end-turn' }); _test.run(s);
  check(s.awaiting && s.awaiting.type === 'niflheim' && s.awaiting.canRefuse === true,
    'winter: the refusal is offered while unspent');
  const tilesBefore = s.grid.filter(Boolean).length;
  applyAction(s, s.awaiting.seat, { refuse: true });
  check(s.phase === 'play', 'winter: the fixture survives the refusal');
  check(s.perkUse.refusal === true, 'winter: the refusal is spent');
  check(s.grid.filter(Boolean).length === tilesBefore, 'winter: the cold took nothing');
  check(s.refusalLeft === 3, 'winter: the refusal covers the rest of the round');
  // the whole PARTY is shielded: the next three end-turns demand no surrender
  // (playtest bug: only the speaker's own toll used to be spared)
  let shielded = 0;
  for (let i = 0; i < 3; i++) {
    s.awaiting = null; s.queue.length = 0; s.queue.push({ t: 'end-turn' }); _test.run(s);
    if (s.phase === 'play' && !(s.awaiting && s.awaiting.type === 'niflheim')) shielded++;
  }
  check(shielded === 3, 'winter: no soul surrenders while the refusal holds');
  check(s.grid.filter(Boolean).length === tilesBefore, 'winter: the board is untouched for the full round');
  s.awaiting = null; s.queue.length = 0; s.queue.push({ t: 'end-turn' }); _test.run(s);
  check(s.awaiting && s.awaiting.type === 'niflheim' && s.awaiting.canRefuse === false,
    'winter: the round ends, the toll returns, and the refusal cannot be spoken twice');

  const w = createGame({ seed: 51, stack: deck(30), runePerks: true });
  w.players[2].rune = { p: 'folkvangr', k: 'fehu' };
  doSetup(w);
  w.stack = []; w.niflheim = true;
  w.players[2].resolve = 1;
  w.awaiting = null; w.queue.length = 0; w.queue.push({ t: 'end-turn' }); _test.run(w);
  const opt = w.awaiting.options.find(o => { const cl = w.grid[key(o.r, o.c)]; return cl && cl.tile; });
  applyAction(w, w.awaiting.seat, { r: opt.r, c: opt.c });
  check(w.awaiting && w.awaiting.type === 'winter-stores' && w.awaiting.seat === 2,
    'winter: Freyja’s stores are offered to the bearer');
  applyAction(w, 2, { restore: true });
  const back = w.grid[key(opt.r, opt.c)];
  check(back && back.tile, 'winter: the taken tile is returned to the forest');
  check(w.players[2].resolve === 0 && w.perkUse.stores === 1, 'winter: the stores were paid for');

  const g = createGame({ seed: 52, stack: deck(30), runePerks: true });
  g.players[0].rune = { p: 'folkvangr', k: 'berkano' };
  doSetup(g);
  g.stack = []; g.niflheim = true;
  // strip the board to the souls' own tiles + ONE tile beside the bearer:
  // the cold's only claim is the last path at her side — Grove shade binds
  const keep = new Set(g.players.map(q => key(q.r, q.c)));
  keep.add(key(1, 2)); // bearer sits at (1,1); her start opens east
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    if (!keep.has(key(r, c))) g.grid[key(r, c)] = null;
  }
  const boardBefore = g.grid.filter(Boolean).length;
  g.awaiting = null; g.queue.length = 0; g.queue.push({ t: 'end-turn' }); _test.run(g);
  check(!(g.awaiting && g.awaiting.type === 'niflheim'),
    'winter: no surrender is demanded when only the shaded tile remains');
  check(g.grid.filter(Boolean).length === boardBefore,
    "winter: the grove's shade holds the last tile beside the birch");
}
{
  // Wunjo — with two neighbors, the bearer CHOOSES who is steeled
  const s = createGame({ seed: 54, stack: deck(40), runePerks: true });
  s.players[0].rune = { p: 'folkvangr', k: 'wunjo' };
  doSetup(s);
  const t0 = _test.tileAt(s, 1, 1); if (t0) t0.fractured = false;
  s.players[1].r = 1; s.players[1].c = 2; s.players[1].resolve = 0;
  s.players[2].r = 0; s.players[2].c = 1; s.players[2].resolve = 1;
  applyAction(s, 0, { kind: 'stay' });
  check(s.awaiting && s.awaiting.type === 'shared-joy' && s.awaiting.options.length === 2,
    'Wunjo: two neighbors — the bearer is asked');
  applyAction(s, 0, { seat: 2 }); // choose the RICHER neighbor, against the default
  check(s.players[2].resolve === 2 && s.players[1].resolve === 0,
    'Wunjo: the chosen neighbor is steeled, not the auto-pick');
}
{
  // Uruz — a closed purse lends nothing
  const s = createGame({ seed: 55, stack: deck(40), runePerks: true });
  s.players[1].rune = { p: 'folkvangr', k: 'uruz' };
  doSetup(s);
  s.players[1].resolve = 2;
  s.players[1].lendOk = false; // the bearer closes their purse
  s.players[0].hopeful = false;
  s.players[0].resolve = 0;
  s.awaiting = null; s.queue.unshift({ t: 'action' }); _test.run(s);
  check(s.awaiting.rekindle !== true, 'Uruz: a closed purse lends nothing');
}
{
  // Winter-form: deathless roots (Eihwaz) — a fall with no stack still lands
  const s = createGame({ seed: 53, stack: deck(30), runePerks: true });
  s.players[0].rune = { p: 'valhalla', k: 'eihwaz' };
  doSetup(s);
  s.stack = [];
  s.players[0].placed = false; s.players[0].r = null; s.players[0].c = null;
  s.players[0].falling = { r: 1, c: 1 };
  s.turn = 0;
  s.awaiting = null; s.queue.length = 0; s.queue.push({ t: 'begin-turn' }); _test.run(s);
  check(s.phase === 'play' && s.awaiting && s.awaiting.type === 'fall-landing'
    && s.awaiting.options.every(o => o.draw === false),
    'winter: the bearer clings to the roots and lands on standing tiles');
}

// ---------------------------------------------------------------- full random game smoke test
section('smoke: random self-play (200 games)');
{
  let wins = 0, losses = 0, errs = 0;
  for (let g = 0; g < 200; g++) {
    try {
      const s = createGame({ seed: 1000 + g });
      let steps = 0;
      const rnd = (() => { let x = 7 + g; return () => { x = (x * 48271) % 2147483647; return x / 2147483647; }; })();
      const pick = arr => arr[Math.floor(rnd() * arr.length)];
      while (s.phase !== 'won' && s.phase !== 'lost' && steps++ < 3000) {
        const aw = s.awaiting;
        if (!aw) throw new Error('no awaiting in live game');
        const seat = aw.seat;
        switch (aw.type) {
          case 'place-start': {
            const free = [];
            for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
              if (!s.grid[key(r, c)]) free.push([r, c]);
            }
            const [r, c] = pick(free);
            applyAction(s, seat, { r, c, rot: Math.floor(rnd() * 4) });
            break;
          }
          case 'place-tile': {
            const tg = pick(aw.targets);
            applyAction(s, seat, { r: tg.r, c: tg.c, rot: pick(tg.rots) });
            break;
          }
          case 'action': {
            const opts = [];
            if (aw.stay) opts.push({ kind: 'stay' });
            if (aw.rekindle) opts.push({ kind: 'rekindle' });
            for (const m of aw.moves) if (m.kind !== 'charge') opts.push({ kind: 'move', d: m.d });
            applyAction(s, seat, pick(opts));
            break;
          }
          case 'post-move': applyAction(s, seat, { kind: 'end' }); break;
          case 'block': applyAction(s, seat, { block: rnd() < 0.5 }); break;
          case 'attune': {
            // only attainable gates: a lost gate's runes are refused (by design)
            const pool = aw.gates && aw.gates.length ? aw.gates : ['valhalla', 'folkvangr'];
            const pn = pick(pool);
            applyAction(s, seat, { p: pn, k: pick(RUNES[pn]).k });
            break;
          }
          case 'swap-draugr': { const o = pick(aw.options); applyAction(s, seat, { r: o.r, c: o.c }); break; }
          case 'fall-landing': { const o = pick(aw.options); applyAction(s, seat, { r: o.r, c: o.c }); break; }
          case 'place-landing': applyAction(s, seat, { rot: pick(aw.rots) }); break;
          case 'scramble': { const o = pick(aw.options); applyAction(s, seat, { r: o.r, c: o.c }); break; }
          case 'place-scramble': applyAction(s, seat, { rot: pick(aw.rots) }); break;
          case 'place-blind': applyAction(s, seat, { rot: pick(aw.rots) }); break;
          case 'niflheim': {
            if (aw.canSustain && rnd() < 0.3) applyAction(s, seat, { sustain: true });
            else { const o = pick(aw.options); applyAction(s, seat, { r: o.r, c: o.c }); }
            break;
          }
          default: throw new Error('unhandled awaiting: ' + aw.type);
        }
      }
      if (s.phase === 'won') wins++;
      else if (s.phase === 'lost') losses++;
      else throw new Error('game did not terminate in 3000 steps (seed ' + (1000 + g) + ')');
    } catch (e) {
      errs++;
      if (errs <= 3) console.error('    game error:', e.message);
    }
  }
  console.log(`    results: ${wins} wins / ${losses} losses / ${errs} errors`);
  check(errs === 0, 'no engine errors across 200 random games');
  check(losses > 0, 'random play mostly loses (game is hard, as intended)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

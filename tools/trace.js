/*
 * Trace one self-play game end-to-end for policy debugging:
 *   node tools/trace.js 505 [--preset hard] [--randomRunes] [--tail 50]
 */
import { createGame, applyAction, TILE_PRESETS, normTiles, key, SIZE } from '../public/shared/engine.js';
import { policy, hasGoodMark, mulberry, planPantheon, tileAt, tilesOf } from './policy.js';

const args = process.argv.slice(2);
const seed = +args.find(a => /^\d+$/.test(a)) || 505;
const preset = args.includes('--preset') ? args[args.indexOf('--preset') + 1] : 'normal';
const randomRunes = args.includes('--randomRunes');
const tail = args.includes('--tail') ? +args[args.indexOf('--tail') + 1] : 50;
const tilesOverride = args.includes('--tiles') ? JSON.parse(args[args.indexOf('--tiles') + 1]) : null;
const gateExits = args.includes('--gateExits') ? args[args.indexOf('--gateExits') + 1] : 'one';
const runePerks = args.includes('--runePerks') || args.includes('--perks');
const perkSet = args.includes('--perks') ? args[args.indexOf('--perks') + 1].split(',') : null;

const rnd = mulberry(seed * 7 + 3);
const ctx = {};
const s = createGame({
  seed,
  tiles: { ...(TILE_PRESETS[preset] || normTiles({})), ...(tilesOverride || {}) },
  randomRunes,
  gateExits,
  runePerks,
  perkSet,
  uruzAdjacent: preset === 'hard',
});

function boardSnap(label) {
  const lines = ['board ' + label + ':'];
  for (let r = 0; r < SIZE; r++) {
    let row = '  ';
    for (let c = 0; c < SIZE; c++) {
      const cl = s.grid[key(r, c)];
      const pl = s.players.find(q => q.placed && q.r === r && q.c === c);
      let ch = ' ';
      if (cl && cl.rift) ch = 'o';
      else if (cl && cl.tile) ch = { gate: 'G', rune: 'R', draugr: 'D' }[cl.tile.kind] || (cl.tile.fractured ? '#' : '.');
      row += (pl ? pl.name[0] : ch) + ' ';
    }
    lines.push(row);
  }
  return lines.join('\n');
}

let steps = 0, empty = 0, snapAtNiflheim = null;
const fullLog = [];
let lastLogLen = 0;
while (s.phase !== 'won' && s.phase !== 'lost') {
  empty = s.stack.length === 0 ? empty + 1 : 0;
  if (!snapAtNiflheim && s.stack.length === 0) snapAtNiflheim = boardSnap('when the stack died');
  if (++steps > 6000 || empty > 600) { fullLog.push('[harness] stalemate cutoff'); break; }
  applyAction(s, s.awaiting.seat, policy(s, rnd, ctx));
  // engine log is capped; mirror it fully with stack annotations
  const fresh = s.log.slice(Math.max(0, s.log.length - (s.log.length - lastLogLen)));
  for (const l of s.log.slice(-(s.log.length - Math.min(lastLogLen, s.log.length)) || s.log.length)) { /* noop */ }
  while (lastLogLen < s.log.length) { fullLog.push(`[stack ${String(s.stack.length).padStart(2)}] ${s.log[lastLogLen].m}`); lastLogLen++; }
  if (s.log.length >= 250) lastLogLen = s.log.length; // cap hit; accept drift
}

console.log(`seed ${seed} → ${s.phase}${s.lossReason ? ' — ' + s.lossReason : ''}`);
console.log(`turns ${s.turnsTaken}, stack ${s.stack.length}, plan ${ctx.plan}, marks ${s.players.filter(p => hasGoodMark(s, p, ctx.plan)).length}`);
console.log('players:', s.players.map(p =>
  `${p.name}@${p.placed ? p.r + ',' + p.c : (p.falling ? 'FALLING' : '?')} ${p.hopeful ? 'lit' : 'dark'} ◆${p.resolve} ${p.rune ? p.rune.p[0] + ':' + p.rune.k : '-'}`).join('  '));
console.log('gates on board:', tilesOf(s, 'gate').map(([r, c]) => `${tileAt(s, r, c).gate}@${r},${c}`).join(' ') || 'none');
// ASCII boards: tile glyph + player initial. G=gate R=circle D=draugr o=rift
// .=path #=fractured path (uppercase letter = player standing there)
if (snapAtNiflheim) console.log('\n' + snapAtNiflheim);
console.log('\n' + boardSnap('at the end'));

console.log(`\n--- last ${tail} log lines ---`);
for (const l of fullLog.slice(-tail)) console.log(' ', l);

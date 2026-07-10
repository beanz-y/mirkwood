/*
 * Mirkwood policy benchmark — the standard A/B measurement matrix.
 *
 *   node tools/bench.js                                  # greedy+planner on all 3 configs
 *   node tools/bench.js --modes planner --configs control,mid
 *   node tools/bench.js --modes plan4 --configs control  # rollout milestone check
 *   node tools/bench.js --out tools/bench-baseline.json --label baseline
 *   node tools/bench.js --compare tools/bench-baseline.json   # print deltas vs saved run
 *
 * Every policy change gets measured on the SAME configs and SAME seeds, so runs
 * are directly comparable (games are seed-deterministic; see selfplay.js).
 * Win-rate differences smaller than ~2σ are noise — the σ column is printed;
 * when comparing, trust the marks + loss-split shifts long before a sub-σ win%.
 *
 * Configs (fixed seeds, chosen to match the baselines in SELFPLAY_NOTES.md):
 *   control — cross:40,rune:10,draugr:0 · the winnable variant where win% is a
 *             real signal (greedy ~19.5%, planner ~21.8%, planner+M4 ~31%)
 *   mid     — cross:24 on Normal · draugr + scarce circles; tactics dominate
 *   normal  — the live Normal preset · wins are rare; watch marks + loss split
 *
 * Modes: greedy · planner · plan4/plan8 (planner + rollouts 4/8; ~0.5-1s/game,
 * use --scale to shrink, or reserve for milestone checks).
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const JOBS = opt('jobs', '16');
const SCALE = +opt('scale', 1);
const LABEL = opt('label', '');
const OUT = opt('out', null);
const COMPARE = opt('compare', null);
const GAMES_OVERRIDE = opt('games', null); // force one game count on every cell

const CONFIGS = {
  //           extra selfplay args                         seed    games
  control: { tiles: { cross: 40, rune: 10, draugr: 0 }, seed: 30000, games: 2000 },
  mid:     { tiles: { cross: 24 },                      seed: 20000, games: 6000 },
  normal:  { tiles: null,                               seed: 1000,  games: 6000 },
};
const MODES = {
  greedy:  [],
  planner: ['--planner'],
  plan4:   ['--planner', '--rollouts', '4'],
  plan8:   ['--planner', '--rollouts', '8'],
};

const configNames = opt('configs', 'control,mid,normal').split(',').map(s => s.trim()).filter(Boolean);
const modeNames = opt('modes', 'greedy,planner').split(',').map(s => s.trim()).filter(Boolean);
for (const c of configNames) if (!CONFIGS[c]) { console.error(`unknown config "${c}" (have: ${Object.keys(CONFIGS)})`); process.exit(1); }
for (const m of modeNames) if (!MODES[m]) { console.error(`unknown mode "${m}" (have: ${Object.keys(MODES)})`); process.exit(1); }

// ---------------------------------------------------------------- loss buckets

// map the engine's loss-reason strings (as truncated by selfplay's report) to
// the failure modes the tuning work actually tracks
function bucketOf(reason) {
  if (reason.startsWith('Too many Rune Circles')) return 'scarcity';
  if (reason.startsWith('The cold has severed')) return 'severed';
  if (reason.startsWith('The Gate of')) return 'gateOrphan';
  if (reason.startsWith('Both gates')) return 'gatesLost';
  if (/void|nothing to land|falls/.test(reason)) return 'fall';
  if (/stalemate/.test(reason)) return 'stalemate';
  if (/surrender/.test(reason)) return 'concede';
  return 'other';
}

// ---------------------------------------------------------------- run one cell

function runCell(configName, modeName) {
  const cfg = CONFIGS[configName];
  const games = Math.max(1, Math.round((GAMES_OVERRIDE ? +GAMES_OVERRIDE : cfg.games) * SCALE));
  const jsonPath = join(tmpdir(), `mk-bench-${process.pid}-${configName}-${modeName}.json`);
  const argv = [
    'tools/selfplay.js',
    '--games', String(games),
    '--seed', String(cfg.seed),
    '--preset', 'normal',
    '--jobs', JOBS,
    '--json', jsonPath,
    ...MODES[modeName],
  ];
  if (cfg.tiles) argv.push('--tiles', JSON.stringify(cfg.tiles));
  process.stderr.write(`\n── ${configName} / ${modeName} · ${games} games ──\n`);
  const res = spawnSync(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  if (res.status !== 0) { console.error(`selfplay failed for ${configName}/${modeName} (exit ${res.status})`); return null; }
  let data;
  try { data = JSON.parse(readFileSync(jsonPath, 'utf8')); } finally { try { unlinkSync(jsonPath); } catch { /* keep going */ } }
  const s = data.summary;
  const buckets = {};
  for (const [reason, n] of Object.entries(s.lossReasons || {})) {
    const b = bucketOf(reason);
    buckets[b] = (buckets[b] || 0) + n;
  }
  return {
    games: s.games, errors: s.errors, wins: s.wins, winRate: s.winRate,
    sigma: +(100 * Math.sqrt((s.wins / Math.max(1, s.games)) * (1 - s.wins / Math.max(1, s.games)) / Math.max(1, s.games))).toFixed(2),
    avgGoodMarks: s.avgGoodMarks, avgStackLeft: s.avgStackLeft, avgTurns: s.avgTurns,
    msPerGame: s.msPerGame, buckets,
  };
}

// ---------------------------------------------------------------- table

const pct = (n, total) => total ? (100 * n / total).toFixed(1) : '-';
function printTable(cells, base) {
  const cols = ['config', 'mode', 'games', 'win%', '±σ', 'marks', 'scar%', 'sever%', 'fall%', 'other%', 'ms/g'];
  if (base) cols.splice(5, 0, 'Δwin', 'Δ/σ');
  const rows = [cols];
  for (const [k, r] of Object.entries(cells)) {
    if (!r) continue;
    const [config, mode] = k.split('/');
    const other = Object.entries(r.buckets).filter(([b]) => !['scarcity', 'severed', 'fall'].includes(b)).reduce((n, [, v]) => n + v, 0);
    const row = [config, mode, String(r.games), r.winRate.toFixed(2), r.sigma.toFixed(2),
      String(r.avgGoodMarks), pct(r.buckets.scarcity || 0, r.games), pct(r.buckets.severed || 0, r.games),
      pct(r.buckets.fall || 0, r.games), pct(other, r.games), String(r.msPerGame)];
    if (base) {
      const b = base.cells && base.cells[k];
      if (b) {
        const d = r.winRate - b.winRate;
        const sig = Math.sqrt(r.sigma ** 2 + (b.sigma || 0) ** 2) || 1;
        row.splice(5, 0, (d >= 0 ? '+' : '') + d.toFixed(2), (d / sig).toFixed(1));
      } else row.splice(5, 0, '-', '-');
    }
    rows.push(row);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  for (let i = 0; i < rows.length; i++) {
    console.log(rows[i].map((cell, j) => cell[j === 0 || j === 1 ? 'padEnd' : 'padStart'](w[j])).join('  '));
    if (i === 0) console.log(w.map(n => '─'.repeat(n)).join('──'));
  }
}

// ---------------------------------------------------------------- main

const base = COMPARE ? JSON.parse(readFileSync(COMPARE, 'utf8')) : null;
const t0 = Date.now();
const cells = {};
for (const c of configNames) for (const m of modeNames) cells[`${c}/${m}`] = runCell(c, m);

console.log(`\n=== Mirkwood bench${LABEL ? ' — ' + LABEL : ''} (scale ${SCALE}, jobs ${JOBS}, ${((Date.now() - t0) / 1000).toFixed(0)}s) ===`);
if (base) console.log(`deltas vs ${COMPARE}${base.meta && base.meta.label ? ' (' + base.meta.label + ')' : ''} — |Δ/σ| < 2 is noise`);
printTable(cells, base);

if (OUT) {
  writeFileSync(OUT, JSON.stringify({
    meta: { date: new Date().toISOString(), label: LABEL, args: args.join(' ') },
    cells,
  }, null, 2));
  console.log(`\nsaved to ${OUT}`);
}

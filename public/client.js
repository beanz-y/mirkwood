/* Mirkwood client — lobby, board rendering, decisions. */
import { RUNES, GATE_NAMES, exitsFor, SIZE, key, DIRNAMES, TILE_PRESETS } from '/shared/engine.js';

const $ = id => document.getElementById(id);
const CS = 90, PAD = 6; // cell size / board padding (viewBox 552)

// ---------------------------------------------------------------- connection

let ws = null;
let room = null;
let state = null;
let token = localStorage.getItem('mk-token') || '';
let lastCode = localStorage.getItem('mk-code') || '';
let myName = localStorage.getItem('mk-name') || '';
let reconnectTimer = null;

// interaction state
let previewRot = 0;
let awaitingSig = '';
let moveAgainArmed = false;
let clickMap = new Map(); // "r,c" -> handler
let transientFx = null;   // choreographed one-shot animation timeline
let decisionDeadline = null; // soft turn-timer deadline for the current decision
let soulSeat = null;      // which soul the status card shows (null = auto)

function updateTimer() {
  const el = $('turn-timer');
  if (!el) return;
  if (!decisionDeadline || !state || (state.phase !== 'play' && state.phase !== 'setup')) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const left = Math.ceil((decisionDeadline - Date.now()) / 1000);
  if (left <= 0) {
    el.textContent = '⌛ 0:00';
    el.classList.add('urgent');
    return;
  }
  el.classList.toggle('urgent', left <= 10);
  el.textContent = `⌛ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}
setInterval(updateTimer, 500);
let anims = localStorage.getItem('mk-anims') !== 'off';
const sm = s => (anims ? s : ''); // gate SMIL snippets on the animations setting

// Choreographed one-shot animations: the engine emits semantic events in
// resolution order; each event is assigned a start time so a single action
// (move -> path crumbles -> draugr strikes -> tiles fade) plays as a sequence.
function buildTimeline(events, cap = 2.8) {
  if (!anims || !events || !events.length) return null;
  const T = {
    moves: {}, dims: {}, brights: {}, shakes: {},
    falls: [], collapses: [], fades: [], reveals: {}, attacks: [],
    banishes: [], runes: [], blooms: [], stays: [], burn: false, total: 0,
  };
  let t = 0;
  // token movement is kept as ordered segments per soul so a whole replayed
  // turn (move -> move again, or land -> move) chains smoothly
  const seg = (seat, s) => { (T.moves[seat] = T.moves[seat] || []).push(s); };
  for (const e of events) {
    switch (e.e) {
      case 'move':
        seg(e.seat, { from: e.from, to: e.to, drop: false, at: t });
        t += 0.32; break;
      case 'land':
        seg(e.seat, { from: null, to: [e.r, e.c], drop: true, at: t });
        t += 0.4; break;
      case 'fall':
        T.falls.push({ seat: e.seat, from: e.from, r: e.r, c: e.c, at: t });
        t += 0.6; break;
      case 'fracture':
        T.collapses.push({ r: e.r, c: e.c, tile: e.tile, at: t });
        t += 0.3; break;
      case 'reveal':
        T.reveals[e.r * SIZE + e.c] = { at: t };
        t += 0.15; break;
      case 'attack': {
        const maxRay = Math.max(0, ...e.rays.map(ray => ray.length));
        T.attacks.push({ m: e.m, rays: e.rays, at: t });
        t += 0.4 + maxRay * 0.06; break;
      }
      case 'hit':
        T.shakes[e.seat] = { at: t };
        T.dims[e.seat] = t + 0.1;
        t += 0.3; break;
      case 'sweep':
        for (const cl of e.cells) T.fades.push({ r: cl.r, c: cl.c, tile: cl.tile, rift: cl.rift, at: t });
        t += 0.35; break;
      case 'banish':
        T.banishes.push({ r: e.r, c: e.c, tile: e.tile, at: t });
        t += 0.6; break;
      case 'rune':
        T.runes.push({ seat: e.seat, at: t });
        t += 0.5; break;
      case 'rekindle':
        T.blooms.push({ seat: e.seat, at: t });
        T.brights[e.seat] = t;
        t += 0.3; break;
      case 'stay':
        T.stays.push({ seat: e.seat, at: t });
        t += 0.25; break;
      case 'burn':
        T.burn = true; break;
    }
  }
  // long chains stay snappy: compress the whole sequence into the cap
  if (t > cap) {
    const k = cap / t;
    const sc = o => { if (o && typeof o.at === 'number') o.at *= k; };
    Object.values(T.moves).forEach(arr => arr.forEach(sc));
    Object.values(T.shakes).forEach(sc);
    Object.values(T.reveals).forEach(sc);
    for (const s of Object.keys(T.dims)) T.dims[s] *= k;
    for (const s of Object.keys(T.brights)) T.brights[s] *= k;
    [T.falls, T.collapses, T.fades, T.attacks, T.banishes, T.runes, T.blooms, T.stays]
      .forEach(arr => arr.forEach(sc));
    t = cap;
  }
  T.total = t;
  return T;
}

// The room code is part of the WebSocket URL so the Cloudflare Worker can
// route the connection to that room's Durable Object.
function setConn(st) {
  const d = $('conn-dot');
  if (!d) return;
  d.className = 'conn ' + st;
  d.title = { on: 'Connected', wait: 'Reconnecting…', off: 'Disconnected' }[st] || st;
}

function openSocket(query, onReady) {
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch { /* gone */ } }
  setConn('wait');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?${query}`);
  ws.onopen = () => { setConn('on'); onReady(); };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => {
    clearTimeout(reconnectTimer);
    if (lastCode && token) { setConn('wait'); reconnectTimer = setTimeout(rejoin, 2000); }
    else setConn('off');
  };
}

function rejoin() {
  if (!lastCode) return; // token may be empty on a first visit: the server mints one
  openSocket(`room=${encodeURIComponent(lastCode)}`, () =>
    send({ t: 'join', code: lastCode, name: myName, token }));
}

function leaveRoom(message) {
  lastCode = '';
  localStorage.removeItem('mk-code');
  room = null; state = null;
  soulSeat = null; transientFx = null; moveAgainArmed = false; modalLock = null;
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; try { ws.close(); } catch { /* gone */ } }
  $('lobby').classList.remove('hidden');
  $('game').classList.add('hidden');
  $('lobby-entry').classList.remove('hidden');
  $('lobby-room').classList.add('hidden');
  $('modal').classList.add('hidden');
  $('preview').classList.add('hidden');
  $('lobby-error').textContent = message || '';
}

// tell the room we're going, then return to the entry screen
function leaveSaga() {
  send({ t: 'leave' });
  leaveRoom();
}

// shared SVG gradient defs for the procedural art, injected once so both the
// board and the tile-preview panel can reference them
document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <radialGradient id="mk-ground" cx="50%" cy="40%" r="85%">
    <stop offset="0%" stop-color="#2e4837"/><stop offset="70%" stop-color="#20362a"/><stop offset="100%" stop-color="#152419"/>
  </radialGradient>
  <linearGradient id="mk-stone" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#54634f"/><stop offset="100%" stop-color="#39443c"/>
  </linearGradient>
  <radialGradient id="mk-void" cx="50%" cy="50%" r="62%">
    <stop offset="0%" stop-color="#1c0e33"/><stop offset="55%" stop-color="#0c0618"/><stop offset="100%" stop-color="#050309"/>
  </radialGradient>
  <radialGradient id="mk-gold" cx="50%" cy="40%" r="65%">
    <stop offset="0%" stop-color="#f2d489" stop-opacity="0.75"/><stop offset="100%" stop-color="#f2d489" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="mk-green" cx="50%" cy="40%" r="65%">
    <stop offset="0%" stop-color="#9fe8c0" stop-opacity="0.7"/><stop offset="100%" stop-color="#9fe8c0" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="mk-ember" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#ffb45e" stop-opacity="0.85"/><stop offset="60%" stop-color="#d96f35" stop-opacity="0.45"/><stop offset="100%" stop-color="#d96f35" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="mk-spectre" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#dbe8f7"/><stop offset="100%" stop-color="#8ba3c4"/>
  </linearGradient>
</defs></svg>`);

// custom art: public/art/manifest.json maps art keys to image URLs
// (see art/README.md); anything missing falls back to the built-in SVG art
let art = {};
fetch('/art/manifest.json')
  .then(r => (r.ok ? r.json() : {}))
  .then(m => { art = m || {}; if (room) render(); })
  .catch(() => { /* no manifest, procedural art only */ });

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
const act = payload => send({ t: 'act', payload });

function handle(msg) {
  switch (msg.t) {
    case 'joined':
      token = msg.token; lastCode = msg.code;
      localStorage.setItem('mk-token', token);
      localStorage.setItem('mk-code', lastCode);
      break;
    case 'room':
      room = msg.room;
      if (!room.started) state = null;
      render();
      break;
    case 'state': {
      state = msg.state;
      transientFx = buildTimeline(state.events);
      render();
      break;
    }
    case 'chat': addChat(msg.from, msg.text); break;
    case 'error':
      if (msg.fatal) leaveRoom(msg.msg);
      else showError(msg.msg);
      break;
  }
}

function toast(text, ok) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.style.cssText = `position:fixed;top:52px;left:50%;transform:translateX(-50%);padding:8px 18px;border-radius:8px;z-index:99;font-size:14px;border:1px solid ${ok ? 'var(--good)' : 'var(--danger)'};background:${ok ? '#16301f' : '#3a1c1c'};color:${ok ? 'var(--good)' : 'var(--danger)'};`;
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

function copyInvite() {
  if (!room || !room.code) return;
  const url = `${location.origin}/?room=${room.code}`;
  navigator.clipboard.writeText(url).then(
    () => toast('Invite link copied — send it to your party!', true),
    () => toast(url, true), // clipboard blocked: at least show it
  );
}
$('room-tag').onclick = copyInvite;
$('room-code').onclick = copyInvite;

function showError(text) {
  if (!room || !room.started) { $('lobby-error').textContent = text; return; }
  toast(text, false);
}

// ---------------------------------------------------------------- lobby wiring

$('create-btn').onclick = () => {
  myName = $('name-input').value.trim() || 'Wanderer';
  localStorage.setItem('mk-name', myName);
  openSocket('new=1', () => send({ t: 'create', name: myName, token }));
};
$('join-btn').onclick = () => {
  myName = $('name-input').value.trim() || 'Wanderer';
  localStorage.setItem('mk-name', myName);
  const code = $('code-input').value.toUpperCase().trim();
  if (!code) { showError('Enter a saga code.'); return; }
  openSocket(`room=${encodeURIComponent(code)}`, () => send({ t: 'join', code, name: myName, token }));
};
$('claim-all-btn').onclick = () => send({ t: 'claimAll' });
$('start-btn').onclick = () => send({ t: 'start' });
$('name-input').value = myName;

// ------- difficulty (host) -------
const CFG_KEYS = ['straight', 'tee', 'teeFractured', 'cross', 'rune', 'draugr'];
function pushConfig(label) {
  const cfg = { label };
  for (const k of CFG_KEYS) cfg[k] = +$('cfg-' + k).value;
  cfg.gateValhalla = $('cfg-gateValhalla').checked ? 1 : 0;
  cfg.gateFolkvangr = $('cfg-gateFolkvangr').checked ? 1 : 0;
  cfg.randomRunes = $('cfg-randomRunes').checked ? 1 : 0;
  cfg.turnTimer = +$('cfg-turnTimer').value;
  send({ t: 'config', config: cfg });
}
const randomRunesOn = () => ($('cfg-randomRunes').checked ? 1 : 0);
const timerVal = () => +$('cfg-turnTimer').value;
$('preset-normal').onclick = () => send({ t: 'config', config: { ...TILE_PRESETS.normal, randomRunes: randomRunesOn(), turnTimer: timerVal(), label: 'Normal' } });
$('preset-hard').onclick = () => send({ t: 'config', config: { ...TILE_PRESETS.hard, randomRunes: randomRunesOn(), turnTimer: timerVal(), label: 'Hard' } });
$('custom-toggle').onclick = () => $('custom-tiles').classList.toggle('hidden');
for (const k of CFG_KEYS) $('cfg-' + k).onchange = () => pushConfig('Custom');
$('cfg-gateValhalla').onchange = () => pushConfig('Custom');
$('cfg-gateFolkvangr').onchange = () => pushConfig('Custom');
// variants are orthogonal to difficulty: toggling them keeps the preset label
$('cfg-randomRunes').onchange = () => pushConfig((room && room.config && room.config.label) || 'Normal');
$('cfg-turnTimer').onchange = () => pushConfig((room && room.config && room.config.label) || 'Normal');

$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (text) send({ t: 'chat', text });
  $('chat-input').value = '';
};
function selectTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  for (const pane of ['log', 'soul', 'chat']) $(pane).classList.toggle('hidden', pane !== name);
}
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => selectTab(btn.dataset.tab);
});

// replay the previous player's entire turn — available to every player and
// spectator (the server keeps the last completed turn's events in the state)
$('replay-btn').onclick = () => {
  if (!state || !state.lastTurn || !state.lastTurn.events.length || !anims) return;
  transientFx = buildTimeline(state.lastTurn.events, 5);
  render();
};

// rules overlay
function openRules() { $('rules').classList.remove('hidden'); }
$('rules-btn').onclick = openRules;
$('rules-btn-lobby').onclick = openRules;
$('rules-close').onclick = () => $('rules').classList.add('hidden');
$('rules').onclick = (e) => { if (e.target === $('rules')) $('rules').classList.add('hidden'); };

// animations setting
function applyAnims() {
  document.body.classList.toggle('no-anims', !anims);
  $('anims-btn').textContent = anims ? 'Animations: on' : 'Animations: off';
}
$('anims-btn').onclick = () => {
  anims = !anims;
  localStorage.setItem('mk-anims', anims ? 'on' : 'off');
  applyAnims();
  if (room) render();
};
applyAnims();
$('concede-btn').onclick = () => {
  confirmModal('Abandon all hope and surrender the saga to Niflheim?', () => send({ t: 'concede' }));
};
$('leave-room-btn').onclick = () => leaveSaga();
$('leave-btn').onclick = () => {
  if (state && (state.phase === 'play' || state.phase === 'setup')) {
    confirmModal(`Leave this saga? The game continues without you — rejoin any time with code ${room ? room.code : ''} from this browser.`, leaveSaga);
  } else {
    leaveSaga();
  }
};
$('rotate-btn').onclick = () => rotatePreview();
document.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') rotatePreview();
});

function addChat(from, text) {
  const p = document.createElement('p');
  const f = document.createElement('span');
  f.className = 'from'; f.textContent = from + ': ';
  p.appendChild(f);
  p.appendChild(document.createTextNode(text));
  $('chat-messages').appendChild(p);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

// ---------------------------------------------------------------- helpers

const mySeats = () => room ? room.seats.filter(s => s.you).map(s => s.seat) : [];
const isMine = seat => mySeats().includes(seat);
const seatName = seat => (state ? state.players[seat].name : (room && room.seats[seat].name) || '?');

function legalRots(aw) {
  if (!aw) return [0, 1, 2, 3];
  if (aw.type === 'place-start') return [0, 1, 2, 3];
  if (aw.type === 'place-tile') {
    const set = new Set();
    aw.targets.forEach(t => t.rots.forEach(r => set.add(r)));
    return [...set].sort();
  }
  if (aw.rots) return aw.rots;
  return [0, 1, 2, 3];
}

function rotatePreview() {
  const aw = state && state.awaiting;
  const rots = legalRots(aw);
  if (!rots.length) return;
  const i = rots.indexOf(previewRot);
  previewRot = rots[(i + 1) % rots.length];
  render();
}

// ---------------------------------------------------------------- render

function render() {
  if (!room) return;
  const started = room.started && state;
  $('lobby').classList.toggle('hidden', !!started);
  $('game').classList.toggle('hidden', !started);
  if (!started) { renderLobby(); return; }
  document.body.classList.toggle('niflheim', !!state.niflheim);

  // reset per-awaiting interaction state
  const aw = state.awaiting;
  const sig = aw ? `${aw.type}:${aw.seat}:${aw.tile ? aw.tile.id : ''}:${state.log.length}` : 'none';
  if (sig !== awaitingSig) {
    awaitingSig = sig;
    moveAgainArmed = false;
    const rots = legalRots(aw);
    previewRot = rots.includes(previewRot) ? previewRot : (rots[0] ?? 0);
    // soft turn timer: a fresh countdown for every decision
    const tt = room.config && room.config.turnTimer;
    decisionDeadline = (tt && aw && (state.phase === 'play' || state.phase === 'setup'))
      ? Date.now() + tt * 1000 : null;
    updateTimer();
  }

  renderTopbar();
  renderPlayers();
  renderSoul();
  renderDiscard();
  renderLog();
  renderBoard();
  renderActionBar();
  renderPreviewPanel();
  renderModal();
  $('concede-btn').classList.toggle('hidden', !room.youAreHost || state.phase !== 'play' && state.phase !== 'setup');
  transientFx = null; // one-shot: replays (rotate, art load) render without them
}

function renderLobby() {
  $('lobby-entry').classList.toggle('hidden', !!room.code);
  $('lobby-room').classList.toggle('hidden', !room.code);
  if (!room.code) return;
  $('room-code').textContent = room.code;
  const list = $('seat-list');
  list.innerHTML = '';
  const colors = ['#e8b23c', '#d05e5e', '#4fb8a8', '#a678d8'];
  room.seats.forEach(s => {
    const div = document.createElement('div');
    div.className = 'seat' + (s.claimed ? ' claimed' : '') + (s.you ? ' you' : '');
    const kick = room.youAreHost && s.claimed && !s.you
      ? `<button class="seat-kick" title="Release this soul">✕</button>` : '';
    div.innerHTML = `<div class="seat-name" style="color:${colors[s.seat]}">Soul ${s.seat + 1}${kick}</div>
      <div class="seat-sub">${s.claimed ? escapeHtml(s.name) + (s.you ? ' (you)' : '') : 'unclaimed — click to take'}</div>`;
    div.onclick = () => send({ t: 'claim', seat: s.seat });
    const kb = div.querySelector('.seat-kick');
    if (kb) kb.onclick = (e) => { e.stopPropagation(); send({ t: 'kick', seat: s.seat }); };
    list.appendChild(div);
  });
  const allClaimed = room.seats.every(s => s.claimed);
  $('start-btn').classList.toggle('hidden', !room.youAreHost);
  $('start-btn').disabled = !allClaimed;
  $('start-hint').textContent = allClaimed
    ? (room.youAreHost ? 'All souls claimed. The forest waits.' : 'Waiting for the host to begin...')
    : 'All four souls must be claimed. One player may claim several.';

  // difficulty: host edits, everyone sees the summary
  const cfg = room.config || { ...TILE_PRESETS.normal, label: 'Normal' };
  $('diff-host').classList.toggle('hidden', !room.youAreHost);
  $('preset-normal').classList.toggle('active', cfg.label === 'Normal');
  $('preset-hard').classList.toggle('active', cfg.label === 'Hard');
  $('custom-toggle').classList.toggle('active', cfg.label === 'Custom');
  if (room.youAreHost && !$('custom-tiles').contains(document.activeElement)) {
    for (const k of CFG_KEYS) $('cfg-' + k).value = cfg[k];
    $('cfg-gateValhalla').checked = !!cfg.gateValhalla;
    $('cfg-gateFolkvangr').checked = !!cfg.gateFolkvangr;
    $('cfg-randomRunes').checked = !!cfg.randomRunes;
    $('cfg-turnTimer').value = String(cfg.turnTimer || 0);
  }
  const total = CFG_KEYS.reduce((n, k) => n + cfg[k], 0) + cfg.gateValhalla + cfg.gateFolkvangr;
  const gates = cfg.gateValhalla + cfg.gateFolkvangr;
  $('diff-summary').textContent =
    `${cfg.label || 'Custom'} — ${total} tiles · ${cfg.rune} rune circles · ${cfg.draugr} draugr · ${gates} gate${gates === 1 ? '' : 's'}`
    + (cfg.randomRunes ? ' · random runes' : '')
    + (cfg.turnTimer ? ` · ${cfg.turnTimer}s timer` : '');
}

function renderTopbar() {
  $('room-tag').textContent = room.code;
  const n = state.stackCount;
  $('stack-meter').innerHTML = `Hope remaining: <b>${n}</b> tiles`;
  $('stack-meter').classList.toggle('low', n <= 10);
  if (transientFx && transientFx.burn) {
    const m = $('stack-meter');
    m.classList.remove('burnflash');
    void m.offsetWidth; // restart the flash animation
    m.classList.add('burnflash');
  }
  const lt = state.lastTurn;
  $('replay-btn').classList.toggle('hidden', !anims || !lt || !lt.events.length);
  if (lt) $('replay-btn').title = `Replay ${seatName(lt.seat)}'s last turn`;
  const banner = $('turn-banner');
  banner.innerHTML = bannerText();
  const aw = state.awaiting;
  banner.classList.toggle('mine',
    !!(aw && isMine(aw.seat) && state.phase !== 'won' && state.phase !== 'lost'));
}

function bannerText() {
  const aw = state.awaiting;
  if (state.phase === 'won') return `<span class="who">The gate of ${GATE_NAMES[state.winnerGate]} is open!</span>`;
  if (state.phase === 'lost') return `<span class="who">The mist has taken them all.</span>`;
  if (!aw) return '';
  const who = `<span style="color:${state.players[aw.seat].color}">◈</span> <span class="who">${seatName(aw.seat)}</span>`;
  const mine = isMine(aw.seat) ? ' — your decision' : '';
  const texts = {
    'place-start': `${who} chooses where to awaken${mine}`,
    'place-tile': `${who} reveals new paths${mine}`,
    'action': `${who} must move or stay${mine}`,
    'post-move': `${who} may press on or rest${mine}`,
    'block': `${who} is struck by a Draugr${mine}`,
    'attune': `${who} stands among the runes${mine}`,
    'swap-draugr': `a Draugr stalks toward ${who}${mine}`,
    'fall-landing': `${who} tumbles through the void${mine}`,
    'place-landing': `${who} reaches for footing${mine}`,
    'place-blind': `${who} feels through the mist${mine}`,
    'place-scramble': `${who} scrambles for footing${mine}`,
    'scramble': `${who} scrambles away${mine}`,
    'niflheim': `Niflheim demands a tile of ${who}${mine}`,
  };
  return texts[aw.type] || `${who} decides${mine}`;
}

function renderPlayers() {
  const wrap = $('players');
  wrap.innerHTML = '';
  state.players.forEach(p => {
    const div = document.createElement('div');
    const active = state.awaiting && state.awaiting.seat === p.seat;
    div.className = 'pcard' + (p.hopeful ? '' : ' hopeless') + (active ? ' active' : '');
    div.title = "View this soul's status card";
    const runeFlash = transientFx && transientFx.runes.some(rn => rn.seat === p.seat) ? ' flash' : '';
    const rune = p.rune
      ? `<div class="prune ${p.rune.p}${runeFlash}" title="${runeInfo(p.rune).name} (${GATE_NAMES[p.rune.p]})">${runeInfo(p.rune).g}</div>`
      : `<div class="prune none" title="No rune mark yet">·</div>`;
    const status = p.falling
      ? '<span class="falling-tag">falling into the void</span>'
      : (p.hopeful ? 'hopeful' : '<span class="hopeless-tag">hopeless</span>');
    const turnChip = state.phase === 'play' && state.turn === p.seat
      ? '<span class="turn-chip">turn</span>' : '';
    // mid-game seat administration: adopt an abandoned soul; host may release one
    const seatInfo = room.seats[p.seat];
    let admin = '';
    if (seatInfo && !seatInfo.claimed) {
      admin = `<button class="seat-admin" data-act="adopt" title="Take control of this abandoned soul">adopt</button>`;
    } else if (room.youAreHost && seatInfo && seatInfo.claimed && !seatInfo.you) {
      admin = `<button class="seat-admin" data-act="kick" title="Release this soul so another player can adopt it">✕</button>`;
    }
    div.innerHTML = `
      <div class="flame" style="background:${p.color}">${(p.name[0] || '?').toUpperCase()}</div>
      <div class="pinfo">
        <div class="pname">${p.name}${isMine(p.seat) ? ' ✦' : ''}${turnChip}</div>
        <div class="pstat">${status} · resolve <span class="resolve-pips">${'◆'.repeat(p.resolve)}${'◇'.repeat(2 - p.resolve)}</span></div>
      </div>
      ${admin}${rune}`;
    div.onclick = () => { soulSeat = p.seat; selectTab('soul'); renderSoul(); };
    const ab = div.querySelector('.seat-admin');
    if (ab) ab.onclick = (e) => {
      e.stopPropagation();
      if (ab.dataset.act === 'adopt') send({ t: 'claim', seat: p.seat });
      else confirmModal(`Release ${p.name}'s soul so another player can adopt it? Their player can rejoin and re-adopt it too.`, () => send({ t: 'kick', seat: p.seat }));
    };
    wrap.appendChild(div);
  });
}

function renderSoul() {
  const el = $('soul');
  if (!state) { el.innerHTML = ''; return; }
  let seat = soulSeat;
  if (seat === null) {
    const mine = mySeats();
    if (state.awaiting && mine.includes(state.awaiting.seat)) seat = state.awaiting.seat;
    else if (mine.length) seat = mine[0];
    else seat = state.turn;
  }
  const p = state.players[seat];
  const cls = p.falling ? 'falling' : (p.hopeful ? 'hopeful' : 'hopeless');
  const word = p.falling ? 'FALLING' : (p.hopeful ? 'HOPEFUL' : 'HOPELESS');
  const sub = p.falling
    ? 'Tumbling through the void between the worlds.'
    : p.hopeful
      ? 'A flicker of hope lights the paths around you.'
      : 'The mist has swallowed your light.';
  const can = [], cant = [];
  if (p.falling) {
    can.push('Next turn: land on any empty, unlit space in the fallen rift’s row or column — a tile is drawn for you to land on.');
    can.push('You will land <b>hopeless</b>. Keep 1 ◆ ready to rekindle, or land beside a hopeful soul.');
    cant.push('You light nothing while you fall.');
  } else if (p.hopeful) {
    can.push('You light every connected path one space around you (no diagonals).');
    can.push('Move along connected paths — new tiles are revealed at your open passages.');
    can.push('Stay to steel your Resolve (+1 ◆, max 2 — but standing still burns a tile).');
    cant.push('Two souls never share a tile (Gates excepted).');
    cant.push('You cannot step onto a Draugr unless you Charge (1 ◆).');
  } else {
    can.push('You see only the tile you stand on.');
    can.push('You <b>must move</b> every turn — staying costs 1 ◆ (Endure).');
    can.push('Moving into the mist reveals only the single tile you step onto.');
    can.push('Rekindle: stand beside a hopeful soul on a connected path (automatic), or spend 1 ◆ at the start of your turn.');
    cant.push('You reveal no other paths while hopeless.');
    cant.push('Step carefully — a Draugr drawn beneath your feet strikes at once.');
  }
  const acts = [
    ['Move again', 'after your move, move once more (max twice a turn)', !p.falling],
    ['Rekindle', 'regain hope at the start of your turn', !p.hopeful],
    ['Endure', 'stay put while hopeless', !p.hopeful && !p.falling],
    ['Brace', 'lose 2 tiles instead of 3 when a Draugr strikes', true],
    ['Charge', 'take a Draugr’s strike head-on to banish it from the forest', p.hopeful],
    ['Sustain', 'skip Niflheim’s toll at the end of your turn', !!state.niflheim],
  ];
  const actHtml = acts.map(([name, desc, relevant]) => `
    <div class="soul-act ${p.resolve > 0 && relevant ? '' : 'unavailable'}">
      <span class="cost">1◆</span><span><b>${name}</b> — <small>${desc}</small></span>
    </div>`).join('');
  let runeLine = state.randomRunes
    ? 'Bears no rune mark yet — find a Rune Circle and let the stones choose.'
    : 'Bears no rune mark yet — find a Rune Circle.';
  if (p.rune) {
    const i = runeInfo(p.rune);
    const col = p.rune.p === 'valhalla' ? 'var(--gold)' : 'var(--good)';
    runeLine = `Marked with <span class="glyph" style="color:${col}">${i.g}</span> ${i.name} — bound for <b>${GATE_NAMES[p.rune.p]}</b>.`;
  }
  el.innerHTML = `
    <div class="soul-card ${cls}">
      <div class="soul-head">
        <div class="flame" style="background:${p.color}">${(p.name[0] || '?').toUpperCase()}</div>
        <div>
          <div class="soul-name">${escapeHtml(p.name)}${isMine(seat) ? ' ✦' : ''}</div>
          <div class="pstat">resolve <span class="resolve-pips">${'◆'.repeat(p.resolve)}${'◇'.repeat(2 - p.resolve)}</span></div>
        </div>
      </div>
      <div class="soul-state">${word}</div>
      <div class="soul-sub">${sub}</div>
      <ul>
        ${can.map(t => `<li>${t}</li>`).join('')}
        ${cant.map(t => `<li class="cant">${t}</li>`).join('')}
      </ul>
      <h4>Spend Resolve (1 ◆ each)</h4>
      <div class="soul-acts">${actHtml}</div>
      <div class="soul-rune-line">${runeLine}</div>
    </div>
    <p class="hint" style="padding:6px 2px">Click any soul above to view their card ·
      <button id="soul-rules" class="btn tiny">Full rules</button></p>`;
  const rb = document.getElementById('soul-rules');
  if (rb) rb.onclick = openRules;
}

function runeInfo(rune) {
  return RUNES[rune.p].find(r => r.k === rune.k);
}

function renderDiscard() {
  const d = state.discard;
  const count = kind => d.filter(t => t.kind === kind).length;
  const gates = d.filter(t => t.kind === 'gate').map(t => GATE_NAMES[t.gate]);
  $('discard-counts').innerHTML = `
    <span class="d-item">paths <b>${count('straight') + count('tee') + count('cross') + count('start')}</b></span>
    <span class="d-item ${count('rune') ? 'bad' : ''}">rune circles <b>${count('rune')}</b>/6</span>
    <span class="d-item">draugr <b>${count('draugr')}</b>/12</span>
    <span class="d-item ${gates.length ? 'bad' : ''}">gates <b>${gates.length ? gates.join(', ') : 'none'}</b></span>`;
}

function renderLog() {
  const el = $('log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.innerHTML = state.log.map(l => `<p class="k-${l.k}">${escapeHtml(l.m)}</p>`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------- board

function renderBoard() {
  const svg = $('board');
  clickMap = new Map();
  const lit = new Set(state.lit);
  const parts = [];

  // background
  parts.push(`<rect x="0" y="0" width="552" height="552" rx="12" fill="#0b1310" stroke="#1c2c22"/>`);
  if (art['board-bg']) {
    parts.push(`<image href="${art['board-bg']}" x="0" y="0" width="552" height="552" preserveAspectRatio="xMidYMid slice"/>`);
  }

  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const x = PAD + c * CS, y = PAD + r * CS;
    const cell = state.grid[key(r, c)];
    if (cell && cell.tile) {
      const tileStr = tileSVG(cell.tile, x, y);
      const rv = transientFx && transientFx.reveals[key(r, c)];
      parts.push(rv ? `<g class="reveal" style="animation-delay:${rv.at}s">${tileStr}</g>` : tileStr);
    } else if (cell && cell.rift) {
      parts.push(riftSVG(x, y));
    } else {
      parts.push(mistCellSVG(x, y, r * 7 + c * 13, lit.has(key(r, c))));
    }
  }

  // choreographed one-shot overlays, in event order
  if (transientFx) {
    for (const cl of transientFx.collapses) {
      // a fractured tile crumbles into the Void
      const x = PAD + cl.c * CS, y = PAD + cl.r * CS;
      parts.push(`<g class="collapse" style="animation-delay:${cl.at}s">${tileSVG(cl.tile, x, y)}</g>`);
    }
    for (const f of transientFx.fades) {
      // lost to the mist
      const x = PAD + f.c * CS, y = PAD + f.r * CS;
      parts.push(`<g class="mistfade" style="animation-delay:${f.at}s">${f.tile ? tileSVG(f.tile, x, y) : riftSVG(x, y)}</g>`);
    }
    for (const atk of transientFx.attacks) {
      // the draugr shrieks, then its spite races down each corridor
      const [mr, mc] = atk.m;
      const mx = PAD + mc * CS, my = PAD + mr * CS;
      parts.push(`<circle cx="${mx + CS / 2}" cy="${my + CS / 2}" r="30" fill="none" stroke="#d05e5e" stroke-width="3" class="shriek" style="animation-delay:${atk.at}s"/>`);
      parts.push(`<rect x="${mx + 2}" y="${my + 2}" width="${CS - 4}" height="${CS - 4}" rx="8" class="raypulse" style="animation-delay:${atk.at}s"/>`);
      for (const ray of atk.rays) {
        ray.forEach(([rr, rc], i) => {
          const x = PAD + rc * CS, y = PAD + rr * CS;
          parts.push(`<rect x="${x + 2}" y="${y + 2}" width="${CS - 4}" height="${CS - 4}" rx="8" class="raypulse" style="animation-delay:${atk.at + 0.12 + i * 0.06}s"/>`);
        });
      }
    }
    for (const b of transientFx.banishes) {
      // a charged draugr disperses into the mist
      const x = PAD + b.c * CS, y = PAD + b.r * CS;
      parts.push(`<g class="banish" style="animation-delay:${b.at}s">${tileSVG(b.tile, x, y)}</g>`);
      parts.push(`<circle cx="${x + CS / 2}" cy="${y + CS / 2}" r="26" fill="none" stroke="#8fd8ff" stroke-width="2.5" class="shriek" style="animation-delay:${b.at}s"/>`);
    }
    for (const f of transientFx.falls) {
      // a ghost of the token tumbles into the rift
      const p = state.players[f.seat];
      const cx = PAD + f.c * CS + CS / 2, cy = PAD + f.r * CS + CS / 2;
      const dx = f.from ? (f.from[1] - f.c) * CS : 0, dy = f.from ? (f.from[0] - f.r) * CS : 0;
      parts.push(`<g class="fallsink" style="--dx:${dx}px;--dy:${dy}px;animation-delay:${f.at}s">
        <circle cx="${cx}" cy="${cy}" r="15" fill="${p.color}" stroke="#0a100d" stroke-width="2"/>
        <text x="${cx}" y="${cy + 4.5}" text-anchor="middle" font-size="14" fill="#0a100d" font-weight="bold" font-family="Georgia">${(p.name[0] || '?').toUpperCase()}</text>
      </g>`);
    }
    for (const st of transientFx.stays) {
      const p = state.players[st.seat];
      if (!p.placed) continue;
      const cx = PAD + p.c * CS + CS / 2, cy = PAD + p.r * CS + CS / 2;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="18" fill="none" stroke="${p.color}" stroke-width="2.5" class="staypulse" style="animation-delay:${st.at}s"/>`);
    }
    for (const b of transientFx.blooms) {
      const p = state.players[b.seat];
      if (!p.placed) continue;
      const cx = PAD + p.c * CS + CS / 2, cy = PAD + p.r * CS + CS / 2;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="16" fill="none" stroke="#f2d489" stroke-width="3" class="bloom" style="animation-delay:${b.at}s"/>`);
    }
  }

  // players
  const byCell = new Map();
  state.players.forEach(p => {
    if (!p.placed) return;
    const k = key(p.r, p.c);
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(p);
  });
  for (const [k, ps] of byCell) {
    const r = Math.floor(k / SIZE), c = k % SIZE;
    const cx = PAD + c * CS + CS / 2, cy = PAD + r * CS + CS / 2;
    const offs = ps.length === 1 ? [[0, 0]] : [[-13, -13], [13, -13], [-13, 13], [13, 13]];
    ps.forEach((p, i) => {
      const [ox, oy] = offs[i] || [0, 0];
      const glow = p.hopeful
        ? `<circle cx="${cx + ox}" cy="${cy + oy}" r="${ps.length === 1 ? 20 : 15}" fill="none" stroke="${p.color}" stroke-opacity="0.35">${sm('<animate attributeName="stroke-opacity" values="0.35;0.1;0.35" dur="2.2s" repeatCount="indefinite"/>')}</circle>`
        : '';
      // whose-turn ring beneath the acting soul's token
      const ring = state.phase === 'play' && state.turn === p.seat
        ? `<circle cx="${cx + ox}" cy="${cy + oy}" r="${(ps.length === 1 ? 15 : 11) + 9}" fill="none" stroke="${p.color}" stroke-width="2" stroke-dasharray="7 6" stroke-opacity="0.8">${sm(`<animateTransform attributeName="transform" type="rotate" from="0 ${cx + ox} ${cy + oy}" to="360 ${cx + ox} ${cy + oy}" dur="10s" repeatCount="indefinite"/>`)}</circle>`
        : '';
      // choreographed one-shots: slide from previous tile / drop from a fall,
      // hope dimming or brightening at its moment in the sequence, hit shake.
      // Delayed SMIL uses begin="indefinite" + beginElementAt after insertion;
      // a holding transform keeps the token at its origin until the slide runs.
      let slide = '', hold = '', opacityAttr = p.hopeful ? '' : 'opacity="0.55"', opacityAnim = '';
      let shakeOpen = '<g>', shakeClose = '</g>';
      if (transientFx) {
        // ordered movement segments, in coordinates relative to the FINAL cell
        // so consecutive slides chain (each freezes where the next begins)
        const segs = transientFx.moves[p.seat];
        if (segs && segs.length) {
          const rel = cell => [(cell[1] - c) * CS, (cell[0] - r) * CS];
          const pieces = [];
          let first = true;
          for (const sg of segs) {
            const [tx, ty] = rel(sg.to);
            let fx, fy, dur;
            if (sg.drop) { fx = tx; fy = ty - 70; dur = 0.45; }
            else {
              [fx, fy] = rel(sg.from);
              const wrapSeg = Math.abs(sg.from[0] - sg.to[0]) > 1 || Math.abs(sg.from[1] - sg.to[1]) > 1;
              dur = wrapSeg ? 0.02 : 0.32; // wrap moves snap across the looping edge
            }
            if (first) { hold = `transform="translate(${fx} ${fy})"`; first = false; }
            pieces.push(`<animateTransform attributeName="transform" type="translate" from="${fx} ${fy}" to="${tx} ${ty}" dur="${dur}s" calcMode="spline" keySplines="0.25 0.1 0.25 1" keyTimes="0;1" fill="freeze" begin="indefinite" data-mk-delay="${sg.at}"/>`);
          }
          slide = pieces.join('');
        }
        const dimAt = transientFx.dims[p.seat];
        const brightAt = transientFx.brights[p.seat];
        if (!p.hopeful && dimAt !== undefined) {
          opacityAttr = 'opacity="1"';
          opacityAnim = `<animate attributeName="opacity" to="0.55" dur="0.25s" fill="freeze" begin="indefinite" data-mk-delay="${dimAt}"/>`;
        } else if (p.hopeful && brightAt !== undefined) {
          opacityAttr = 'opacity="0.55"';
          opacityAnim = `<animate attributeName="opacity" to="1" dur="0.3s" fill="freeze" begin="indefinite" data-mk-delay="${brightAt}"/>`;
        }
        const shake = transientFx.shakes[p.seat];
        if (shake) { shakeOpen = `<g class="shake" style="animation-delay:${shake.at}s">`; }
      }
      const tokenArt = art[`token-${p.seat}`];
      const R = ps.length === 1 ? 18 : 13;
      const body = tokenArt
        ? `<image href="${tokenArt}" x="${cx + ox - R}" y="${cy + oy - R}" width="${R * 2}" height="${R * 2}"/>`
        : `<circle cx="${cx + ox}" cy="${cy + oy}" r="${ps.length === 1 ? 15 : 11}" fill="${p.color}" stroke="#0a100d" stroke-width="2"/>
           ${glow}
           <text x="${cx + ox}" y="${cy + oy + 4.5}" text-anchor="middle" font-size="${ps.length === 1 ? 14 : 11}" fill="#0a100d" font-weight="bold" font-family="Georgia">${(p.name[0] || '?').toUpperCase()}</text>`;
      parts.push(`<g ${opacityAttr} ${hold}>${slide}${opacityAnim}${shakeOpen}${ring}${tokenArt ? glow : ''}${body}${shakeClose}</g>`);
    });
  }

  // rune attunement burst above everything
  if (transientFx) {
    for (const rn of transientFx.runes) {
      const p = state.players[rn.seat];
      if (!p.placed || !p.rune) continue;
      const info = RUNES[p.rune.p].find(rr => rr.k === p.rune.k);
      const col = p.rune.p === 'valhalla' ? '#e8b23c' : '#6fce9a';
      const cx = PAD + p.c * CS + CS / 2, cy = PAD + p.r * CS + CS / 2;
      parts.push(`<g class="runeburst" style="animation-delay:${rn.at}s">
        <circle cx="${cx}" cy="${cy}" r="22" fill="none" stroke="${col}" stroke-width="2"/>
        <text x="${cx}" y="${cy - 24}" text-anchor="middle" font-size="32" fill="${col}" font-family="Georgia">${info.g}</text>
      </g>`);
    }
  }

  // interaction highlights + click targets
  const aw = state.awaiting;
  const myDecision = aw && isMine(aw.seat) && state.phase !== 'won' && state.phase !== 'lost';
  if (myDecision) addInteractions(parts, aw);
  svg.classList.toggle('my-turn', !!myDecision);

  svg.innerHTML = parts.join('');

  // start delayed SMIL animations relative to now (begin offsets in markup
  // would be relative to document load, not insertion)
  svg.querySelectorAll('[data-mk-delay]').forEach(a => {
    try { a.beginElementAt(parseFloat(a.getAttribute('data-mk-delay'))); } catch { /* no SMIL */ }
  });

  // wire clicks
  svg.querySelectorAll('[data-click]').forEach(el => {
    el.addEventListener('click', () => {
      const h = clickMap.get(el.getAttribute('data-click'));
      if (h) h();
    });
  });
}

function hlRect(x, y, cls) {
  return `<rect x="${x + 4}" y="${y + 4}" width="${CS - 8}" height="${CS - 8}" rx="8" class="hl ${cls}"/>`;
}
function clickRect(parts, r, c, cls, handler) {
  const x = PAD + c * CS, y = PAD + r * CS;
  const id = `${r},${c},${cls}`;
  parts.push(hlRect(x, y, cls));
  parts.push(`<rect x="${x}" y="${y}" width="${CS}" height="${CS}" fill="transparent" class="clickable" data-click="${id}"/>`);
  clickMap.set(id, handler);
}

function addInteractions(parts, aw) {
  switch (aw.type) {
    case 'place-start': {
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
        if (!state.grid[key(r, c)]) {
          clickRect(parts, r, c, 'place', () => act({ r, c, rot: previewRot }));
        }
      }
      break;
    }
    case 'place-tile': {
      aw.targets.filter(t => t.rots.includes(previewRot)).forEach(t => {
        clickRect(parts, t.r, t.c, 'place', () => act({ r: t.r, c: t.c, rot: previewRot }));
      });
      break;
    }
    case 'place-blind':
    case 'place-landing':
    case 'place-scramble': {
      clickRect(parts, aw.r, aw.c, 'place', () => act({ rot: previewRot }));
      break;
    }
    case 'action': {
      aw.moves.forEach(m => {
        clickRect(parts, m.r, m.c, m.kind, () => {
          if (m.kind === 'charge') {
            confirmModal('Charge the Draugr? Its strike WILL land on you — but with its spite spent, it is banished from the forest. (1 Resolve)', () => act({ kind: 'move', d: m.d }));
          } else if (m.kind === 'jump') {
            confirmModal('Leap into the Void Rift? You will fall, and land hopeless.', () => act({ kind: 'move', d: m.d }));
          } else {
            act({ kind: 'move', d: m.d });
          }
        });
      });
      break;
    }
    case 'post-move': {
      if (moveAgainArmed && aw.canMoveAgain) {
        aw.moves.forEach(m => {
          clickRect(parts, m.r, m.c, m.kind, () => {
            if (m.kind === 'charge') {
              confirmModal('Charge the Draugr? Its strike WILL land on you, then it is banished. (2 Resolve in total)', () => act({ kind: 'move', d: m.d }));
            } else if (m.kind === 'jump') {
              confirmModal('Leap into the Void Rift?', () => act({ kind: 'move', d: m.d }));
            } else {
              act({ kind: 'move', d: m.d });
            }
          });
        });
      }
      break;
    }
    case 'swap-draugr': {
      aw.options.forEach(o => clickRect(parts, o.r, o.c, 'charge', () => act({ r: o.r, c: o.c })));
      break;
    }
    case 'fall-landing': {
      aw.options.forEach(o => clickRect(parts, o.r, o.c, 'jump', () => act({ r: o.r, c: o.c })));
      break;
    }
    case 'scramble': {
      aw.options.forEach(o => clickRect(parts, o.r, o.c, 'move', () => act({ r: o.r, c: o.c })));
      break;
    }
    case 'niflheim': {
      aw.options.forEach(o => clickRect(parts, o.r, o.c, 'remove', () => act({ r: o.r, c: o.c })));
      break;
    }
  }
}

// ---------------------------------------------------------------- tile art

// a two-tier pine silhouette, base centered at (px, py)
function pine(px, py, s, fill) {
  return `<path d="M ${px - s * 0.5} ${py} l ${s * 0.5} ${-s * 0.95} l ${s * 0.5} ${s * 0.95} z
    M ${px - s * 0.36} ${py - s * 0.55} l ${s * 0.36} ${-s * 0.7} l ${s * 0.36} ${s * 0.7} z
    M ${px - s * 0.08} ${py} h ${s * 0.16} v ${s * 0.18} h ${-s * 0.16} z" fill="${fill}"/>`;
}

function tileSVG(tile, x, y) {
  const cx = x + CS / 2, cy = y + CS / 2;
  const exits = tile.exits || exitsFor(tile.kind, tile.rot || 0);

  // custom art override: image is authored in rot-0 orientation and the
  // whole piece is rotated with the tile (see art/README.md)
  const artKey = tile.kind === 'gate' ? `gate-${tile.gate}` : tile.kind;
  const src = (tile.fractured && art[`${artKey}-fractured`]) || art[artKey];
  if (src) {
    let out = `<image href="${src}" x="${x + 1}" y="${y + 1}" width="${CS - 2}" height="${CS - 2}" preserveAspectRatio="xMidYMid slice" transform="rotate(${(tile.rot || 0) * 90} ${cx} ${cy})"/>`;
    if (tile.fractured && !art[`${artKey}-fractured`]) out += crackSVG(x, y);
    return out;
  }

  const seed = (x * 31 + y * 17) | 0;
  const parts = [];
  // forest floor
  parts.push(`<rect x="${x + 2.5}" y="${y + 2.5}" width="${CS - 5}" height="${CS - 5}" rx="9" fill="url(#mk-ground)" stroke="#33503f" stroke-width="1.5"/>`);
  // seeded corner growth: pines or moss clumps
  const corners = [[x + 13, y + 21], [x + CS - 13, y + 22], [x + 14, y + CS - 9], [x + CS - 14, y + CS - 10]];
  corners.forEach(([px, py], i) => {
    if ((seed >> i) & 1) parts.push(pine(px, py, 13, '#1b2f22'));
    else parts.push(`<circle cx="${px}" cy="${py - 5}" r="4.5" fill="#24402f"/><circle cx="${px + 5}" cy="${py - 2}" r="3" fill="#1e3627"/>`);
  });
  // stone passages: dark earth edging under a stone causeway, flagstones on top
  const ends = [[cx, y + 2.5], [x + CS - 2.5, cy], [cx, y + CS - 2.5], [x + 2.5, cy]];
  for (let d = 0; d < 4; d++) {
    if (!exits[d]) continue;
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${ends[d][0]}" y2="${ends[d][1]}" stroke="#37452f" stroke-width="30"/>`);
  }
  for (let d = 0; d < 4; d++) {
    if (!exits[d]) continue;
    const [ex, ey] = ends[d];
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${ex}" y2="${ey}" stroke="url(#mk-stone)" stroke-width="25"/>`);
    for (let f = 1; f <= 2; f++) {
      const vert = d % 2 === 0;
      const jit = ((seed >> (d + f)) & 1) ? 3 : -3;
      const fx = cx + (ex - cx) * (f * 0.34) + (vert ? jit : 0);
      const fy = cy + (ey - cy) * (f * 0.34) + (vert ? 0 : jit);
      parts.push(`<ellipse cx="${fx}" cy="${fy}" rx="${vert ? 7 : 5}" ry="${vert ? 5 : 7}" fill="#49574a" stroke="#303c31" stroke-width="1.2"/>`);
    }
  }
  if (exits.some(Boolean)) {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="14" fill="url(#mk-stone)" stroke="#303c31" stroke-width="1.2"/>`);
  }

  // kind decorations
  if (tile.kind === 'start') {
    // a cold campfire in the clearing where the soul awoke
    parts.push(`<circle cx="${cx}" cy="${cy}" r="13" fill="url(#mk-ember)"/>`);
    parts.push(`<rect x="${cx - 7.5}" y="${cy - 1.6}" width="15" height="3.2" rx="1.6" fill="#4a3a28" transform="rotate(28 ${cx} ${cy})"/>`);
    parts.push(`<rect x="${cx - 7.5}" y="${cy - 1.6}" width="15" height="3.2" rx="1.6" fill="#57432c" transform="rotate(-38 ${cx} ${cy})"/>`);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + (seed % 7) * 0.3;
      parts.push(`<circle cx="${cx + Math.cos(a) * 11.5}" cy="${cy + Math.sin(a) * 11.5}" r="2.5" fill="#6d7a64" stroke="#414d40" stroke-width="0.8"/>`);
    }
  } else if (tile.kind === 'rune') {
    // standing stones at the diagonals around a ritual ring
    parts.push(`<circle cx="${cx}" cy="${cy}" r="12" fill="url(#mk-gold)" opacity="0.55"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="19" fill="none" stroke="#d8c27a" stroke-width="1.6" stroke-dasharray="5 4" opacity="0.85"/>`);
    const stones = [[-18, -18], [18, -18], [-18, 18], [18, 18]];
    const glyphs = ['ᚠ', 'ᚢ', 'ᛃ', 'ᛜ'];
    stones.forEach(([sx, sy], i) => {
      parts.push(`<path d="M ${cx + sx - 5.5} ${cy + sy + 8} l 1.6 -13.5 q 4 -4.5 7.8 0 l 1.6 13.5 z" fill="url(#mk-stone)" stroke="#39463a" stroke-width="1"/>`);
      parts.push(`<text x="${cx + sx}" y="${cy + sy + 4}" text-anchor="middle" font-size="7.5" fill="#e8d9a0" font-family="Georgia" opacity="0.95">${glyphs[i]}</text>`);
    });
    parts.push(`<text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="17" fill="#efe0a8" font-family="Georgia">ᚱ</text>`);
  } else if (tile.kind === 'gate') {
    // the whole monument rotates with the tile so the doorway faces its passage
    const rot = (tile.rot || 0) * 90;
    const col = tile.gate === 'valhalla' ? '#e8b23c' : '#6fce9a';
    const glowId = tile.gate === 'valhalla' ? 'mk-gold' : 'mk-green';
    const g1 = tile.gate === 'valhalla' ? 'ᚦ' : 'ᛒ';
    const g2 = tile.gate === 'valhalla' ? 'ᚱ' : 'ᚹ';
    parts.push(`<g transform="rotate(${rot} ${cx} ${cy})">
      <ellipse cx="${cx}" cy="${cy - 6}" rx="27" ry="24" fill="url(#${glowId})"/>
      <rect x="${cx - 13}" y="${y + 5}" width="26" height="5" rx="1.5" fill="#4a4438"/>
      <rect x="${cx - 16}" y="${y + 10}" width="32" height="4" rx="1.5" fill="#3c372e"/>
      <ellipse cx="${cx}" cy="${cy - 3}" rx="11" ry="15" fill="url(#${glowId})"/>
      <rect x="${cx - 21}" y="${cy - 12}" width="8" height="28" rx="2" fill="url(#mk-stone)" stroke="#39463a" stroke-width="1"/>
      <rect x="${cx + 13}" y="${cy - 12}" width="8" height="28" rx="2" fill="url(#mk-stone)" stroke="#39463a" stroke-width="1"/>
      <rect x="${cx - 23}" y="${cy - 16}" width="12" height="5" rx="1.5" fill="#5d6b58" stroke="#39463a" stroke-width="0.8"/>
      <rect x="${cx + 11}" y="${cy - 16}" width="12" height="5" rx="1.5" fill="#5d6b58" stroke="#39463a" stroke-width="0.8"/>
      <path d="M ${cx - 22} ${cy - 13} Q ${cx} ${cy - 37} ${cx + 22} ${cy - 13}" fill="none" stroke="${col}" stroke-width="5.5"/>
      <path d="M ${cx - 4} ${cy - 28} l 4 -5.5 l 4 5.5 l -4 5.5 z" fill="${col}"/>
      <text x="${cx - 17}" y="${cy + 2}" text-anchor="middle" font-size="7" fill="#1c2a22" font-family="Georgia">${g1}</text>
      <text x="${cx + 17}" y="${cy + 2}" text-anchor="middle" font-size="7" fill="#1c2a22" font-family="Georgia">${g2}</text>
    </g>`);
    parts.push(`<text x="${cx}" y="${y + CS - 8}" text-anchor="middle" font-size="9.5" fill="${col}" font-family="Georgia" letter-spacing="1.5">${tile.gate === 'valhalla' ? 'VALHALLA' : 'FÓLKVANGR'}</text>`);
  } else if (tile.kind === 'draugr') {
    // a hooded specter with cold-burning eyes, wreathed in grave-mist
    const body = `M ${cx - 15} ${cy + 15} C ${cx - 18} ${cy - 4} ${cx - 13} ${cy - 18} ${cx} ${cy - 18} C ${cx + 13} ${cy - 18} ${cx + 18} ${cy - 4} ${cx + 15} ${cy + 15} L ${cx + 10} ${cy + 9} L ${cx + 5} ${cy + 16} L ${cx} ${cy + 10} L ${cx - 5} ${cy + 16} L ${cx - 10} ${cy + 9} Z`;
    parts.push(`<g>
      <ellipse cx="${cx}" cy="${cy + 17}" rx="15" ry="4.5" fill="#0a1410" opacity="0.65"/>
      <path d="${body}" fill="url(#mk-spectre)" opacity="0.25" transform="translate(${cx} ${cy}) scale(1.18) translate(${-cx} ${-cy})"/>
      <path d="${body}" fill="url(#mk-spectre)" opacity="0.95"/>
      <path d="M ${cx - 11} ${cy - 9} q 11 -7 22 0 l -2 6 q -9 -5 -18 0 z" fill="#5a7091" opacity="0.85"/>
      <circle cx="${cx - 5.5}" cy="${cy - 4}" r="2.7" fill="#101820"/>
      <circle cx="${cx + 5.5}" cy="${cy - 4}" r="2.7" fill="#101820"/>
      <circle cx="${cx - 5.5}" cy="${cy - 4}" r="1.1" fill="#8fd8ff"/>
      <circle cx="${cx + 5.5}" cy="${cy - 4}" r="1.1" fill="#8fd8ff"/>
      <path d="M ${cx - 3.5} ${cy + 3.5} q 3.5 3 7 0" stroke="#2c3a4d" stroke-width="1.6" fill="none"/>
      <path d="M ${cx - 19} ${cy + 8} q -5 -3 -4 -9 M ${cx + 19} ${cy + 8} q 5 -3 4 -9" stroke="#b9cce4" stroke-width="1.5" fill="none" opacity="0.5"/>
      <circle cx="${cx}" cy="${cy}" r="23" fill="none" stroke="#aebfd6" stroke-opacity="0.3">${sm('<animate attributeName="stroke-opacity" values="0.3;0.08;0.3" dur="2.6s" repeatCount="indefinite"/>')}</circle>
    </g>`);
  }

  // fracture cracks — the void already seeping through
  if (tile.fractured) parts.push(crackSVG(x, y));
  return parts.join('');
}

function crackSVG(x, y) {
  return `<g>
    <path d="M ${x + 16} ${y + 18} l 9 7 l -5 9 l 11 8 l -4 9" stroke="#43306b" stroke-width="4.5" fill="none" opacity="0.4" stroke-linecap="round"/>
    <path d="M ${x + 16} ${y + 18} l 9 7 l -5 9 l 11 8 l -4 9 M ${x + CS - 17} ${y + CS - 21} l -8 -6 l 4 -8 l -10 -7" stroke="#101812" stroke-width="2.2" fill="none" opacity="0.95"/>
  </g>`;
}

function riftSVG(x, y) {
  const cx = x + CS / 2, cy = y + CS / 2;
  if (art.rift) {
    return `<image href="${art.rift}" x="${x + 1}" y="${y + 1}" width="${CS - 2}" height="${CS - 2}" preserveAspectRatio="xMidYMid slice"/>`;
  }
  return `<g>
    <rect x="${x + 1}" y="${y + 1}" width="${CS - 2}" height="${CS - 2}" rx="6" fill="url(#mk-void)"/>
    <path d="M ${x + 6} ${y + 25} l 13 3 M ${x + CS - 6} ${y + 35} l -12 2 M ${x + 31} ${y + CS - 5} l 3 -11 M ${x + 60} ${y + 6} l -4 12" stroke="#2b1848" stroke-width="2" opacity="0.85"/>
    <circle cx="${cx}" cy="${cy}" r="26" fill="none" stroke="#5c3e8f" stroke-width="2" stroke-opacity="0.7" stroke-dasharray="10 6">${sm(`<animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="14s" repeatCount="indefinite"/>`)}</circle>
    <circle cx="${cx}" cy="${cy}" r="15" fill="none" stroke="#7a55b8" stroke-width="1.6" stroke-opacity="0.6" stroke-dasharray="6 5">${sm(`<animateTransform attributeName="transform" type="rotate" from="360 ${cx} ${cy}" to="0 ${cx} ${cy}" dur="9s" repeatCount="indefinite"/>`)}</circle>
    <circle cx="${cx + 13}" cy="${cy - 14}" r="1.3" fill="#7a55b8" opacity="0.7"/>
    <circle cx="${cx - 16}" cy="${cy + 9}" r="1" fill="#5c3e8f" opacity="0.7"/>
    <circle cx="${cx}" cy="${cy}" r="6" fill="#070310"/>
  </g>`;
}

function mistCellSVG(x, y, seed, isLit) {
  if (!isLit && art.mist) {
    return `<image href="${art.mist}" x="${x + 1}" y="${y + 1}" width="${CS - 2}" height="${CS - 2}" preserveAspectRatio="xMidYMid slice"/>`;
  }
  if (isLit) {
    // an empty clearing your hope can reach — faintly visible ground
    return `<rect x="${x + 1}" y="${y + 1}" width="${CS - 2}" height="${CS - 2}" rx="6" class="cell-empty-lit"/>`
      + pine(x + 16 + (seed % 9), y + CS - 12, 10, '#101c14');
  }
  // deep mist: barely-there trees swallowed by fog
  return `<rect x="${x + 1}" y="${y + 1}" width="${CS - 2}" height="${CS - 2}" rx="6" class="cell-mist"/>`
    + pine(x + 18 + (seed % 14), y + 34, 14, '#0d1811')
    + pine(x + CS - 24 - (seed % 10), y + CS - 12, 17, '#0b150f')
    + `<g opacity="0.5">
        <ellipse cx="${x + 30 + (seed % 20)}" cy="${y + 38}" rx="26" ry="9" fill="#2a3d34" opacity="0.09"/>
        <ellipse cx="${x + 56 - (seed % 16)}" cy="${y + 64}" rx="24" ry="8" fill="#2a3d34" opacity="0.11"/>
      </g>`;
}

// ---------------------------------------------------------------- action bar

function renderActionBar() {
  const bar = $('action-bar');
  bar.innerHTML = '';
  const aw = state.awaiting;
  if (state.phase === 'won' || state.phase === 'lost') return;
  if (!aw) return;
  if (!isMine(aw.seat)) {
    bar.innerHTML = `<span class="note">waiting for ${escapeHtml(seatName(aw.seat))}...</span>`;
    return;
  }
  const note = t => { const s = document.createElement('span'); s.className = 'note'; s.textContent = t; bar.appendChild(s); };
  const btn = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = 'btn small ' + cls; b.innerHTML = label; b.onclick = fn;
    bar.appendChild(b); return b;
  };

  switch (aw.type) {
    case 'place-start': note('Choose any dark clearing to awaken in — rotate your paths with ⟳'); break;
    case 'place-tile': note('Place the revealed tile on a glowing space'); break;
    case 'place-blind': note('Orient the tile you feel beneath your hands, then click it'); break;
    case 'place-landing': note('Choose how you land — rotate, then click'); break;
    case 'place-scramble': note('Orient your footing, then click'); break;
    case 'action': {
      const p = state.players[aw.seat];
      if (aw.rekindle) btn('Rekindle hope <small>(1 ◆)</small>', () => act({ kind: 'rekindle' }));
      if (aw.stay) {
        const label = p.hopeful ? 'Stay <small>(+1 ◆, burn a tile)</small>' : 'Stay <small>(1 ◆)</small>';
        btn(label, () => act({ kind: 'stay' }));
      }
      if (aw.moves.length) note('or click a glowing space to move');
      else note('no paths lead onward');
      break;
    }
    case 'post-move': {
      btn('End turn', () => act({ kind: 'end' }), 'primary');
      if (aw.canMoveAgain) {
        btn(moveAgainArmed ? 'Cancel move' : 'Move again <small>(1 ◆)</small>', () => {
          moveAgainArmed = !moveAgainArmed;
          render();
        });
        if (moveAgainArmed) note('click a glowing space');
      }
      break;
    }
    case 'swap-draugr': note('The Draugr must take a connected path — choose which'); break;
    case 'fall-landing': note('Choose where to fall back into Myrkviðr (along the rift’s row or column)'); break;
    case 'scramble': note('Scramble to an adjacent space'); break;
    case 'niflheim': {
      if (aw.canSustain) btn('Sustain <small>(1 ◆)</small>', () => act({ sustain: true }));
      note('Niflheim claims a tile — click one to surrender it');
      break;
    }
  }
}

// ---------------------------------------------------------------- preview panel

function renderPreviewPanel() {
  const aw = state.awaiting;
  const types = ['place-start', 'place-tile', 'place-blind', 'place-landing', 'place-scramble'];
  const show = aw && types.includes(aw.type) && isMine(aw.seat);
  $('preview').classList.toggle('hidden', !show);
  if (!show) return;
  const tile = aw.type === 'place-start'
    ? { kind: 'start', fractured: true, rot: previewRot }
    : { ...aw.tile, rot: previewRot };
  tile.exits = exitsFor(tile.kind, previewRot);
  $('preview-title').textContent = tileName(tile);
  const svg = $('preview-svg');
  svg.innerHTML = tileSVG(tile, 1, 1).replaceAll(`${CS}`, `${CS}`); // draws at 90 within 92 viewbox
  const rots = legalRots(aw);
  $('rotate-btn').style.display = rots.length > 1 ? '' : 'none';
}

function tileName(tile) {
  return {
    start: 'Forest clearing', straight: 'Straight path', tee: 'Forking path',
    cross: 'Crossroads', rune: 'Rune Circle', draugr: 'Draugr',
    gate: tile.gate ? `Gate of ${GATE_NAMES[tile.gate]}` : 'Gate',
  }[tile.kind] + (tile.fractured ? ' (fractured)' : '');
}

// ---------------------------------------------------------------- modal

let modalLock = null; // custom confirm content

function confirmModal(text, onYes) {
  modalLock = { text, onYes };
  renderModal();
}

function renderModal() {
  const modal = $('modal');
  const card = $('modal-card');
  const aw = state && state.awaiting;

  // custom confirm has priority
  if (modalLock) {
    card.innerHTML = `<p style="font-size:16px;color:var(--text)">${escapeHtml(modalLock.text)}</p>`;
    const row = document.createElement('div'); row.className = 'row';
    const yes = document.createElement('button'); yes.className = 'btn danger'; yes.textContent = 'Do it';
    const no = document.createElement('button'); no.className = 'btn'; no.textContent = 'Never mind';
    yes.onclick = () => { const fn = modalLock.onYes; modalLock = null; fn(); renderModal(); };
    no.onclick = () => { modalLock = null; renderModal(); };
    row.append(yes, no); card.appendChild(row);
    modal.classList.remove('hidden');
    return;
  }

  if (!state) { modal.classList.add('hidden'); return; }

  // endgame
  if (state.phase === 'won' || state.phase === 'lost') {
    const win = state.phase === 'won';
    card.innerHTML = `<div class="endgame ${win ? 'win' : 'loss'}">
      <div style="font-size:44px">${win ? 'ᚹ' : 'ᛁ'}</div>
      <h1>${win ? GATE_NAMES[state.winnerGate].toUpperCase() : 'THE MIST TAKES ALL'}</h1>
      <p>${win
        ? 'The four runes blaze as one. The gate swings wide, and the souls pass out of Myrkviðr forever.'
        : escapeHtml(state.lossReason || 'The souls are lost.')}</p>
    </div>`;
    const row = document.createElement('div'); row.className = 'row';
    if (room.youAreHost) {
      const again = document.createElement('button');
      again.className = 'btn primary'; again.textContent = 'Tell the saga again';
      again.onclick = () => send({ t: 'restart' });
      row.appendChild(again);
    } else {
      const p = document.createElement('p'); p.className = 'hint';
      p.textContent = 'The host may begin a new saga.';
      row.appendChild(p);
    }
    const out = document.createElement('button');
    out.className = 'btn'; out.textContent = 'Leave the forest';
    out.onclick = () => leaveSaga();
    row.appendChild(out);
    card.appendChild(row);
    modal.classList.remove('hidden');
    return;
  }

  // block decision
  if (aw && aw.type === 'block' && isMine(aw.seat)) {
    const p = state.players[aw.seat];
    card.innerHTML = `<h2>The Draugr strikes ${escapeHtml(p.name)}!</h2>
      <p>Its spite burns away the paths. Brace against it?</p>`;
    const row = document.createElement('div'); row.className = 'row';
    const brace = document.createElement('button');
    brace.className = 'btn primary'; brace.innerHTML = 'Brace <small>(1 ◆ — lose 2 tiles)</small>';
    brace.onclick = () => act({ block: true });
    const take = document.createElement('button');
    take.className = 'btn danger'; take.innerHTML = 'Endure it <small>(lose 3 tiles)</small>';
    take.onclick = () => act({ block: false });
    row.append(brace, take); card.appendChild(row);
    modal.classList.remove('hidden');
    return;
  }

  // attune decision — Random Runes variant: accept fate or walk away
  if (aw && aw.type === 'attune' && aw.random && isMine(aw.seat)) {
    const p = state.players[aw.seat];
    const held = aw.taken.map(t => {
      const info = RUNES[t.p].find(rn => rn.k === t.k);
      return `<span class="prune ${t.p}" style="display:inline-block;margin:0 3px" title="${escapeHtml(seatName(t.seat))}">${info.g}</span>`;
    }).join('');
    card.innerHTML = `<h2>The Rune Circle</h2>
      <p>The stones do not ask — they <b>choose</b>. ${escapeHtml(p.name)} may accept a random
      unclaimed mark (it replaces any they bear), or leave fate untested.</p>
      ${held ? `<p class="hint">Marks already borne: ${held}</p>` : ''}`;
    const row = document.createElement('div'); row.className = 'row';
    const draw = document.createElement('button');
    draw.className = 'btn primary'; draw.textContent = 'Let the stones choose';
    draw.onclick = () => act({ draw: true });
    const skip = document.createElement('button');
    skip.className = 'btn'; skip.textContent = 'Leave untouched';
    skip.onclick = () => act({ skip: true });
    row.append(draw, skip); card.appendChild(row);
    modal.classList.remove('hidden');
    return;
  }

  // attune decision
  if (aw && aw.type === 'attune' && isMine(aw.seat)) {
    const p = state.players[aw.seat];
    card.innerHTML = `<h2>The Rune Circle</h2>
      <p>Ancient marks wait in the stones. ${escapeHtml(p.name)} may take one — it replaces any mark they bear. All four souls need <b>different</b> runes of the <b>same</b> gate.</p>`;
    const grid = document.createElement('div'); grid.className = 'rune-grid';
    for (const pantheon of ['valhalla', 'folkvangr']) {
      const col = document.createElement('div'); col.className = 'rune-col ' + pantheon;
      col.innerHTML = `<h4>${GATE_NAMES[pantheon].toUpperCase()}</h4>`;
      RUNES[pantheon].forEach(rn => {
        const holder = aw.taken.find(t => t.p === pantheon && t.k === rn.k);
        const b = document.createElement('button');
        b.className = 'rune-btn' + (holder && holder.seat === aw.seat ? ' mine' : '');
        b.innerHTML = `<span class="glyph">${rn.g}</span><span>${rn.name}<br><small style="color:var(--dim)">${rn.gloss}</small></span>
          ${holder ? `<span class="taken">${escapeHtml(seatName(holder.seat))}</span>` : ''}`;
        b.onclick = () => act({ p: pantheon, k: rn.k });
        col.appendChild(b);
      });
      grid.appendChild(col);
    }
    card.appendChild(grid);
    const row = document.createElement('div'); row.className = 'row';
    const skip = document.createElement('button');
    skip.className = 'btn'; skip.textContent = 'Leave the runes untouched';
    skip.onclick = () => act({ skip: true });
    row.appendChild(skip); card.appendChild(row);
    modal.classList.remove('hidden');
    return;
  }

  modal.classList.add('hidden');
}

// ---------------------------------------------------------------- go

// invite links: /?room=CODE joins that saga directly (first-time visitors get
// the code pre-filled so they can pick a name); otherwise a returning player
// rejoins their last saga
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom && /^[a-zA-Z]{4}$/.test(urlRoom)) {
  const code = urlRoom.toUpperCase();
  history.replaceState(null, '', location.pathname); // don't refight localStorage on refresh
  if (myName) {
    lastCode = code;
    localStorage.setItem('mk-code', code);
    rejoin();
  } else {
    $('code-input').value = code;
    $('lobby-error').textContent = 'You were invited to saga ' + code + ' — choose a name and join!';
    $('name-input').focus();
  }
} else if (lastCode && token) {
  rejoin();
}

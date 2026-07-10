/* Mirkwood client — lobby, board rendering, decisions. */
import {
  RUNES, GATE_NAMES, exitsFor, SIZE, key, DIRNAMES, TILE_PRESETS,
  PLAYER_COLORS, PLAYER_COLOR_NAMES, TOKEN_ICONS, TOKEN_ICON_KEYS, iconSVG,
} from '/shared/engine.js';

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
let lookSeat = null;      // seat whose look picker is open in the lobby
let lastAnimatedSeq = null; // engine action counter: animate each action ONCE
let hiddenAtSeq = null;     // action counter when the tab went to sleep

// Sigils. Commissioned art drops in via the manifest key `sigil-<key>`
// (e.g. "sigil-raven"); it overrides the built-in vector mark everywhere the
// sigil appears, while the soul's chosen COLOR still rides on the disc behind
// it. Missing keys keep the procedural vector — reskin one sigil at a time.

// a sigil as inline HTML (cards, lobby, picker)
function sigilHTML(iconKey, color, size = 16) {
  const src = art['sigil-' + iconKey];
  if (src) return `<img src="${src}" width="${size}" height="${size}" alt="" style="display:block;object-fit:contain">`;
  const ic = TOKEN_ICONS[iconKey];
  if (!ic) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ic.art.replaceAll('CUR', color)}</svg>`;
}

// a sigil for placing into the board SVG (dark mark on the colored disc)
function sigilMark(iconKey, x, y, size) {
  const src = art['sigil-' + iconKey];
  if (src) return `<image href="${src}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
  return iconSVG(iconKey, x, y, size, '#0a100d');
}

// a sigil on a little colored disc — a mini token preview for the lobby/picker,
// so any commissioned mark reads (and shows how the real token will look)
function sigilChip(iconKey, color, px = 18) {
  return `<span class="sigil-chip" style="background:${color};width:${px}px;height:${px}px">`
    + `${sigilHTML(iconKey, '#0a100d', Math.round(px * 0.74))}</span>`;
}

// Touch ("coarse pointer") devices get a two-tap place flow: the first tap
// ghosts the tile on the board, the second tap (or ✓ Place) confirms it.
// ?touch=1 forces it for testing in a desktop browser.
const IS_COARSE = (window.matchMedia && matchMedia('(pointer: coarse)').matches)
  || /[?&]touch=1/.test(location.search);
let armedCell = null;   // "r,c" ghosted and awaiting a confirming second tap (touch)
let armedAction = null; // the confirm for the armed cell (also behind ✓ Place)
let hoverCell = null;   // hovered placement target (desktop ghost preview)
let livePreview = null;    // onlooker's view of the active player's pending placement {seat,r,c,rot}
let lastPreviewSent = '';  // active player: last preview signature broadcast (dedupe)
let pingArmed = false;     // ping mode: the next board click marks a spot for everyone
let lastPingAt = 0;        // local throttle

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

// ---- idle auto-rest ---------------------------------------------------------
// A player who has already MOVED but forgot "End turn" stalls the whole party.
// When the post-move prompt is ours and the page sees no input for IDLE_END_MS,
// end the turn automatically. Any pointer/key/touch activity restarts the
// clock, so someone weighing "Press on" is never cut off. Client-side only —
// a closed tab never auto-ends (the adopt flow covers vanished players).
// ?idleend=N (seconds) overrides the delay for testing, like ?touch=1.
const IDLE_END_MS = (() => {
  const m = location.search.match(/[?&]idleend=(\d+)/);
  return (m ? Math.max(2, +m[1]) : 30) * 1000;
})();
let lastInputAt = Date.now();
let idleEndSig = null; // awaitingSig this decision is armed for (null = off)
for (const evt of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) {
  addEventListener(evt, () => { lastInputAt = Date.now(); }, { passive: true, capture: true });
}
function idleEndTick() {
  if (!idleEndSig || !state || state.phase !== 'play') return;
  const aw = state.awaiting;
  if (!aw || aw.type !== 'post-move' || !isMine(aw.seat) || awaitingSig !== idleEndSig) return;
  const left = Math.ceil((lastInputAt + IDLE_END_MS - Date.now()) / 1000);
  const endBtn = [...document.querySelectorAll('#action-bar button')]
    .find(b => /end turn/i.test(b.textContent));
  if (left > 0) {
    // gentle warning on the button itself for the final stretch
    if (endBtn) {
      let tag = endBtn.querySelector('.auto-end-note');
      if (left <= 10) {
        if (!tag) { tag = document.createElement('small'); tag.className = 'auto-end-note'; endBtn.appendChild(tag); }
        tag.textContent = ` — resting in ${left}s`;
      } else if (tag) tag.remove();
    }
    return;
  }
  idleEndSig = null; // fire exactly once
  act({ kind: 'end' });
}
setInterval(idleEndTick, 500);

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
    banishes: [], runes: [], blooms: [], stays: [], burnFx: [], burn: false, total: 0,
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
        T.burn = true;
        T.burnFx.push({ tiles: e.tiles || [], at: t });
        // a notable loss (a gate, a circle) earns its own beat in the sequence
        if ((e.tiles || []).some(x => x.kind === 'gate' || x.kind === 'rune')) t += 0.45;
        break;
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
    [T.falls, T.collapses, T.fades, T.attacks, T.banishes, T.runes, T.blooms, T.stays, T.burnFx]
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
  lastAnimatedSeq = null; // a fresh connection gets the catch-up treatment
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
    <stop offset="0%" stop-color="#151c13"/><stop offset="70%" stop-color="#10150e"/><stop offset="100%" stop-color="#0b100b"/>
  </radialGradient>
  <linearGradient id="mk-stone" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#333c33"/><stop offset="100%" stop-color="#232b23"/>
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
      const seq = state.seq || 0;
      if (lastAnimatedSeq === null) {
        // just (re)joined: don't replay a single stale action out of context —
        // play the previous turn once instead, as a catch-up highlight
        transientFx = (anims && state.phase === 'play' && state.lastTurn && state.lastTurn.events.length)
          ? buildTimeline(state.lastTurn.events, 5)
          : null;
      } else if (seq !== lastAnimatedSeq) {
        transientFx = buildTimeline(state.events); // a fresh action: animate it live
        showBurnReveal(state.events, transientFx); // name what the mist took (works anims-off too)
      } else {
        transientFx = null; // a room-change rebroadcast: nothing new to show
      }
      lastAnimatedSeq = seq;
      render();
      break;
    }
    case 'preview': {
      // relayed pending placement from the active player — show it live
      if (state && state.awaiting && state.awaiting.seat === msg.seat && !isMine(msg.seat)) {
        livePreview = { seat: msg.seat, r: msg.r, c: msg.c, rot: msg.rot };
        renderLivePreview();
        renderPreviewPanel();
      }
      break;
    }
    case 'ping':
      showPing(msg); // a "look here" marker from any player or watcher
      break;
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

// The primary CTA follows intent: a typed code means "join this saga",
// an empty one means "begin a new one". Enter submits either way.
function updateLobbyCTA() {
  const joining = !!$('code-input').value.trim();
  $('join-btn').classList.toggle('primary', joining);
  $('create-btn').classList.toggle('primary', !joining);
}
$('code-input').addEventListener('input', () => {
  const el = $('code-input');
  el.value = el.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  updateLobbyCTA();
});
$('code-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click(); });
$('name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') ($('code-input').value.trim() ? $('join-btn') : $('create-btn')).click();
});
updateLobbyCTA();

// ------- difficulty (host) -------
const CFG_KEYS = ['straight', 'tee', 'teeFractured', 'cross', 'rune', 'draugr'];
function pushConfig(label) {
  const cfg = { label };
  for (const k of CFG_KEYS) cfg[k] = +$('cfg-' + k).value;
  cfg.gateValhalla = $('cfg-gateValhalla').checked ? 1 : 0;
  cfg.gateFolkvangr = $('cfg-gateFolkvangr').checked ? 1 : 0;
  cfg.randomRunes = $('cfg-randomRunes').checked ? 1 : 0;
  cfg.runePerks = $('cfg-runePerks').checked ? 1 : 0;
  cfg.gateExits = $('cfg-gateExits').value;
  cfg.turnTimer = +$('cfg-turnTimer').value;
  send({ t: 'config', config: cfg });
}
const randomRunesOn = () => ($('cfg-randomRunes').checked ? 1 : 0);
const runePerksOn = () => ($('cfg-runePerks').checked ? 1 : 0);
const gateExitsVal = () => $('cfg-gateExits').value;
const timerVal = () => +$('cfg-turnTimer').value;
$('preset-normal').onclick = () => send({ t: 'config', config: { ...TILE_PRESETS.normal, randomRunes: randomRunesOn(), runePerks: runePerksOn(), gateExits: gateExitsVal(), turnTimer: timerVal(), label: 'Normal' } });
$('preset-hard').onclick = () => send({ t: 'config', config: { ...TILE_PRESETS.hard, randomRunes: randomRunesOn(), runePerks: runePerksOn(), gateExits: gateExitsVal(), turnTimer: timerVal(), label: 'Hard' } });
$('custom-toggle').onclick = () => $('custom-tiles').classList.toggle('hidden');
for (const k of CFG_KEYS) $('cfg-' + k).onchange = () => pushConfig('Custom');
$('cfg-gateValhalla').onchange = () => pushConfig('Custom');
$('cfg-gateFolkvangr').onchange = () => pushConfig('Custom');
// variants are orthogonal to difficulty: toggling them keeps the preset label
$('cfg-randomRunes').onchange = () => pushConfig((room && room.config && room.config.label) || 'Normal');
$('cfg-runePerks').onchange = () => pushConfig((room && room.config && room.config.label) || 'Normal');
$('cfg-gateExits').onchange = () => pushConfig((room && room.config && room.config.label) || 'Normal');
$('cfg-turnTimer').onchange = () => pushConfig((room && room.config && room.config.label) || 'Normal');

// (Whispers/chat removed 2026-07-09 — underused, and Dan wants no user-to-user
// message content flowing through or stored by the app at all; use Ping ⚑ for
// on-board coordination)
function selectTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  for (const pane of ['log', 'soul']) $(pane).classList.toggle('hidden', pane !== name);
}
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => selectTab(btn.dataset.tab);
});

// replay the previous player's entire turn — available to every player and
// spectator (the server keeps the last completed turn's events in the state)
$('replay-btn').onclick = () => {
  if (!state || !state.lastTurn || !state.lastTurn.events.length || !anims) return;
  transientFx = buildTimeline(state.lastTurn.events, 5);
  showBurnReveal(state.lastTurn.events, transientFx);
  render();
};

// ---------------------------------------------------------------- ping
// Point teammates at a spot when you're not on voice. The Ping button arms
// ping mode; the next board tap marks that cell for everyone (a transient
// sonar marker in your colour with your name). Works for any player or watcher.
function updatePingBtn() {
  $('ping-btn').classList.toggle('armed', pingArmed);
  $('board').classList.toggle('ping-armed', pingArmed);
  $('ping-btn').textContent = pingArmed ? '⚑ Tap a spot' : '⚑ Ping';
}
$('ping-btn').onclick = () => { pingArmed = !pingArmed; updatePingBtn(); };

// capture-phase so an armed ping wins over the cell's own move/place handler
$('board').addEventListener('click', (e) => {
  if (!pingArmed) return;
  e.stopPropagation(); e.preventDefault();
  pingArmed = false; updatePingBtn();
  const br = $('board').getBoundingClientRect();
  const vx = (e.clientX - br.left) / br.width * (SIZE * CS + PAD * 2);
  const vy = (e.clientY - br.top) / br.height * (SIZE * CS + PAD * 2);
  const c = Math.floor((vx - PAD) / CS), r = Math.floor((vy - PAD) / CS);
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return;
  const now = Date.now();
  if (now - lastPingAt < 350) return; // local throttle
  lastPingAt = now;
  send({ t: 'ping', r, c });
}, true);

// draw a transient sonar marker at (r,c) in the pinger's colour + name. HTML
// overlay so it's independent of the board SVG's re-renders.
function showPing({ r, c, name, color }) {
  const board = $('board'), wrap = $('board-wrap'), overlay = $('ping-overlay');
  if (!board || !wrap || !overlay || r == null || c == null) return;
  const br = board.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const scale = br.width / (SIZE * CS + PAD * 2);
  const px = (br.left - wr.left) + (PAD + c * CS + CS / 2) * scale;
  const py = (br.top - wr.top) + (PAD + r * CS + CS / 2) * scale;
  const el = document.createElement('div');
  el.className = 'ping';
  el.style.cssText = `left:${px}px; top:${py}px; --pc:${color || '#d9d3c0'}`;
  el.innerHTML = `<span class="ring"></span><span class="ring b"></span><span class="dot"></span>`
    + `<span class="lbl">${escapeHtml((name || '').slice(0, 14))}</span>`;
  overlay.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

// Show WHAT the mist takes when stack tiles burn — players kept missing a
// gate's burning in the log and swearing runes to a dead gate. Chips stack in
// an HTML overlay above the board; a burned GATE gets a big lingering banner.
// Ordinary single path-tile burns (every Stay) stay chip-free — the discard
// tracker flash covers those; chips are for strikes and notable losses.
// Shows even with animations off (static chips, timed removal).
function showBurnReveal(events, T) {
  const overlay = $('burn-overlay');
  if (!overlay || !events || !events.length) return;
  const fx = (T && T.burnFx && T.burnFx.length)
    ? T.burnFx
    : events.filter(e => e.e === 'burn').map(e => ({ tiles: e.tiles || [], at: 0 }));
  for (const b of fx) {
    const tiles = b.tiles || [];
    const notable = tiles.some(x => x.kind === 'gate' || x.kind === 'rune');
    if (!notable && tiles.length <= 1) continue;
    const chips = [];
    let paths = 0, runes = 0, draugar = 0;
    for (const x of tiles) {
      if (x.kind === 'gate') chips.push({ cls: 'gate', text: `The Gate of ${GATE_NAMES[x.gate]} is lost to the mist!` });
      else if (x.kind === 'rune') runes++;
      else if (x.kind === 'draugr') draugar++;
      else paths++;
    }
    if (runes) chips.push({ cls: 'rune', text: runes > 1 ? `${runes} Rune Circles are lost to the mist` : 'A Rune Circle is lost to the mist' });
    if (draugar) chips.push({ cls: 'path', text: draugar > 1 ? `${draugar} draugar sink back into the mist` : 'A Draugr sinks back into the mist' });
    if (paths) chips.push({ cls: 'path', text: paths > 1 ? `${paths} path tiles burn away` : 'A path tile burns away' });
    chips.forEach((ch, i) => {
      const el = document.createElement('div');
      el.className = 'burn-chip ' + ch.cls;
      el.textContent = ch.text;
      const delay = anims ? b.at + i * 0.15 : 0;
      const dur = ch.cls === 'gate' ? 4.6 : 3.0;
      if (anims) el.style.animationDelay = delay + 's';
      overlay.appendChild(el);
      setTimeout(() => el.remove(), (delay + dur) * 1000);
    });
  }
}

// coming back to a tab left sleeping: if turns passed while away, replay the
// previous turn once — a catch-up highlight instead of a silently-changed board
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAtSeq = state ? (state.seq || 0) : null; return; }
  const missed = hiddenAtSeq !== null && state && (state.seq || 0) > hiddenAtSeq;
  hiddenAtSeq = null;
  if (missed && anims && state.phase === 'play' && state.lastTurn && state.lastTurn.events.length) {
    transientFx = buildTimeline(state.lastTurn.events, 5);
    render();
  }
});

// rules overlay
function openRules() { $('rules').classList.remove('hidden'); }
$('rules-btn').onclick = openRules;
$('rules-btn-lobby').onclick = openRules;
$('rules-close').onclick = () => $('rules').classList.add('hidden');
$('rules').onclick = (e) => { if (e.target === $('rules')) $('rules').classList.add('hidden'); };

// ---------------------------------------------------------------- walkthrough
// an optional illustrated primer: each page pairs a short passage with a
// diagram drawn by the same procedural art the board uses
let tutStep = 0;

const tutTile = (kind, rot = 0, opts = {}) => ({ kind, rot, exits: exitsFor(kind, rot), ...opts });
const tutCell = (t, c, r) => tileSVG(t, PAD + c * CS, PAD + r * CS);
const tutMist = (c, r) => {
  const x = PAD + c * CS, y = PAD + r * CS;
  return `<rect x="${x + 1}" y="${y + 1}" width="${CS - 2}" height="${CS - 2}" rx="6" class="cell-mist"/>`
    + pine(x + 26, y + 58, 12, '#0a0f0a');
};
const tutTok = (c, r, ci, icon, o = {}) => {
  const x = PAD + c * CS + CS / 2 + (o.dx || 0), y = PAD + r * CS + CS / 2 + (o.dy || 0);
  const R = o.small ? 10 : 15, S = o.small ? 13 : 19;
  return `<g${o.dim ? ' opacity="0.55"' : ''}>
    ${o.glow ? `<circle cx="${x}" cy="${y}" r="${R + 5}" fill="none" stroke="${PLAYER_COLORS[ci]}" stroke-opacity="0.4"/>` : ''}
    <circle cx="${x}" cy="${y}" r="${R}" fill="${PLAYER_COLORS[ci]}" stroke="#0a100d" stroke-width="2"/>
    ${sigilMark(icon, x - S / 2, y - S / 2, S)}
  </g>`;
};
const tutArrow = (x1, y1, x2, y2, col = '#e8b23c') => {
  const a = Math.atan2(y2 - y1, x2 - x1);
  return `<line x1="${x1}" y1="${y1}" x2="${x2 - 10 * Math.cos(a)}" y2="${y2 - 10 * Math.sin(a)}" stroke="${col}" stroke-width="3" stroke-linecap="round"/>
    <path d="M ${x2} ${y2} L ${x2 - 12 * Math.cos(a - 0.45)} ${y2 - 12 * Math.sin(a - 0.45)} L ${x2 - 12 * Math.cos(a + 0.45)} ${y2 - 12 * Math.sin(a + 0.45)} Z" fill="${col}"/>`;
};
const tutSVG = (cols, rows, inner) =>
  `<svg viewBox="0 0 ${cols * CS + PAD * 2} ${rows * CS + PAD * 2}" style="width:100%;max-width:${cols * 105}px">${inner}</svg>`;

const TUT_PAGES = [
  {
    t: 'Welcome to Myrkviðr',
    d: () => tutSVG(3, 1,
      tutCell(tutTile('cross'), 0, 0)
      + tutCell(tutTile('gate', 1, { gate: 'valhalla' }), 1, 0)
      + tutCell(tutTile('cross'), 2, 0)
      + tutTok(1, 0, 0, 'helm', { small: true, dx: -13, dy: -13 })
      + tutTok(1, 0, 1, 'shield', { small: true, dx: 13, dy: -13 })
      + tutTok(1, 0, 2, 'sword', { small: true, dx: -13, dy: 13 })
      + tutTok(1, 0, 3, 'raven', { small: true, dx: 13, dy: 13 })),
    x: `You died without glory, and the dark wood between the worlds has you. There is one road out: find a <b>Gate</b>, gather its <b>four runes</b> — one different mark on each soul — and stand upon it <b>together</b>. All four of you win, or none. Everything else in Myrkviðr stands between you and that door.`,
  },
  {
    t: 'The Ember of Hope',
    d: () => tutSVG(3, 2,
      tutCell(tutTile('straight', 1), 0, 0) + tutCell(tutTile('straight', 1), 1, 0) + tutCell(tutTile('straight', 1), 2, 0)
      + tutTok(1, 0, 0, 'helm', { glow: true })
      + tutMist(0, 1) + tutCell(tutTile('straight', 1), 1, 1) + tutMist(2, 1)
      + tutTok(1, 1, 1, 'shield', { dim: true })),
    x: `<b>Hopeful</b> (above), your ember lights every joined path one space around you — those tiles stay real. <b>Hopeless</b> (below), you see only the tile you stand on: the dark drives you to <b>move every turn</b>, blind. Stand beside a hopeful soul to be rekindled, or spend 1 ◆ at the start of your turn. And whatever <b>no soul's</b> hope lights is devoured by the mist, forever.`,
  },
  {
    t: 'Move, and kindle the way',
    d: () => tutSVG(3, 1,
      tutCell(tutTile('cross'), 0, 0) + tutCell(tutTile('cross'), 1, 0)
      + `<g class="ghost">${tutCell(tutTile('tee', 1), 2, 0)}</g>`
      + exitMarkers(exitsFor('tee', 1), PAD + 2 * CS, PAD)
      + `<rect x="${PAD + 2 * CS + 3}" y="${PAD + 3}" width="${CS - 6}" height="${CS - 6}" rx="8" class="ghost-outline"/>`
      + tutTok(0, 0, 0, 'helm', { glow: true })
      + tutArrow(PAD + CS * 0.72, PAD + CS / 2, PAD + CS * 1.28, PAD + CS / 2)),
    x: `On your turn, <b>Move</b> one space along a joined path. Your hope kindles the ways ahead: a fresh tile is drawn for every open passage of your new tile, and you choose where it sits and how it turns. Spend 1 ◆ to <b>press on</b> (up to two more steps). Or <b>Stay</b> instead: steel your Resolve (+1 ◆), though hope gutters while you linger — a tile burns from the stack.`,
  },
  {
    t: 'Resolve — the will to go on',
    d: () => `<div class="tut-spends">
      <div>Earn it by <b>standing fast</b> (Stay, +1 ◆) or <b>slipping a Draugr's gaze</b> (+1 ◆). Carry at most two.</div>
      <div><b>Press on</b> — another step after your move</div>
      <div><b>Rekindle</b> — relight your own hope at the start of your turn</div>
      <div><b>Endure</b> — stay put while hopeless</div>
      <div><b>Brace</b> — lose 2 tiles instead of 3 when struck</div>
      <div><b>Berserk</b> — rush a Draugr; its strike lands on you, then it is banished</div>
      <div><b>Ward</b> — during Niflheim's Embrace, spare the forest one tile</div>
    </div>`,
    x: `The path stack is the party's shared hope made visible — every tile drawn, burned, or lost brings the end closer. Resolve ◆ is how a single soul bends the rules for a moment. Spend it well.`,
  },
  {
    t: 'The Draugar',
    d: () => tutSVG(4, 1,
      tutCell(tutTile('draugr'), 0, 0) + tutCell(tutTile('cross'), 1, 0) + tutCell(tutTile('cross'), 2, 0) + tutCell(tutTile('cross'), 3, 0)
      + `<line x1="${PAD + CS / 2}" y1="${PAD + CS / 2}" x2="${PAD + CS * 3.5}" y2="${PAD + CS / 2}" stroke="#d05e5e" stroke-width="5" opacity="0.4"/>`
      + tutTok(2, 0, 0, 'helm')
      + tutArrow(PAD + CS * 2.5, PAD + CS * 0.34, PAD + CS * 2.5, PAD + CS * 0.1, '#6fce9a')),
    x: `A Draugr wakes at <b>motion in its corridors</b>: step anywhere along a straight, unbroken run of path joined to it — however far, even across the board's wrapped edge — and it lashes down all four corridors at once. Every soul caught in its gaze: <b>3 tiles burn</b>, hope extinguished. <b>End your move outside the line</b> (green) and the strike misses you — slipping its gaze steels your Resolve. Walls, gaps, and Void Rifts blind it.`,
  },
  {
    t: 'Fractured paths & Void Rifts',
    d: () => tutSVG(3, 1,
      tutCell(tutTile('cross', 0, { fractured: true }), 0, 0)
      + riftSVG(PAD + CS, PAD)
      + tutCell(tutTile('cross'), 2, 0)
      + tutArrow(PAD + CS * 0.7, PAD + CS * 0.82, PAD + CS * 1.3, PAD + CS * 0.82, '#a678d8')),
    x: `Cracked tiles are <b>Fractured</b>: they crumble into a <b>Void Rift</b> the moment you leave them. Falling ends your turn — next turn you land on a drawn tile anywhere in the rift's row or column, <b>ember still lit</b>. A rift blinds the draugar, and a desperate soul may even leap in on purpose. But fall when the stack is spent, and the void keeps you.`,
  },
  {
    t: 'Rune Circles & the Gates',
    d: () => tutSVG(3, 1,
      tutCell(tutTile('rune', 0, { fractured: true }), 0, 0)
      + tutCell(tutTile('gate', 1, { gate: 'valhalla' }), 1, 0)
      + tutCell(tutTile('gate', 1, { gate: 'folkvangr' }), 2, 0)),
    x: `Step into a <b>Rune Circle</b> to take one mark of either gate — it replaces the mark you bear, and marks are never traded. The stones speak to each soul <b>once</b>: circles crumble behind you. The two Gates — <b>Valgrind</b> of Valhalla, and the gate to Freyja's <b>Fólkvangr</b> — have a single doorway each and are permanent once placed (only Niflheim's Embrace can claim one, and never while a soul stands on it). Four souls, four different runes of one gate, one doorstep: that is the way out.`,
  },
  {
    t: "Niflheim's Embrace",
    d: () => tutSVG(3, 1,
      tutCell(tutTile('cross'), 0, 0)
      + `<g opacity="0.35">${tutCell(tutTile('cross'), 1, 0)}</g>`
      + tutMist(2, 0)
      + `<text x="${PAD + CS * 1.5}" y="${PAD + CS * 0.62}" text-anchor="middle" font-size="34" fill="#9fd4ff" opacity="0.9">ᛁ</text>`),
    x: `When the last tile is drawn, the primordial cold closes in. <b>No new paths can ever be kindled</b>, and at the end of every turn the group surrenders one tile from the board (1 ◆ to <b>Ward</b> it off). The forest dwindles until the souls reach a gate — or nothing remains. The moment no road to a winnable gate survives, the saga ends. Reach the door before the forest is gone.`,
  },
];

function renderTutorial() {
  const pg = TUT_PAGES[tutStep];
  $('tut-title').textContent = pg.t;
  $('tut-diagram').innerHTML = pg.d();
  $('tut-text').innerHTML = pg.x;
  $('tut-step').textContent = `${tutStep + 1} / ${TUT_PAGES.length}`;
  $('tut-prev').disabled = tutStep === 0;
  $('tut-next').textContent = tutStep === TUT_PAGES.length - 1 ? 'Into the forest' : 'Next ›';
}
function openTutorial() { tutStep = 0; renderTutorial(); $('tutorial').classList.remove('hidden'); }
$('tut-btn-lobby').onclick = openTutorial;
$('tut-btn-rules').onclick = () => { $('rules').classList.add('hidden'); openTutorial(); };
$('tut-prev').onclick = () => { if (tutStep > 0) { tutStep--; renderTutorial(); } };
$('tut-next').onclick = () => {
  if (tutStep < TUT_PAGES.length - 1) { tutStep++; renderTutorial(); }
  else $('tutorial').classList.add('hidden');
};
$('tut-close').onclick = () => $('tutorial').classList.add('hidden');
$('tutorial').onclick = (e) => { if (e.target === $('tutorial')) $('tutorial').classList.add('hidden'); };

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
$('preview-svg').addEventListener('click', () => rotatePreview());
document.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // typing, not rotating
  if (e.key === 'r' || e.key === 'R') rotatePreview();
});
// scroll over the board (or the preview) to rotate the pending tile
const placingNow = () => {
  const aw = state && state.awaiting;
  return aw && isMine(aw.seat)
    && ['place-start', 'place-tile', 'place-blind', 'place-landing', 'place-scramble'].includes(aw.type);
};
for (const el of [$('board'), $('preview')]) {
  el.addEventListener('wheel', (e) => {
    if (!placingNow()) return;
    e.preventDefault();
    rotatePreview(e.deltaY < 0 ? -1 : 1);
  }, { passive: false });
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

// rotation choices can differ per cell (a tile only connects at certain
// rotations in certain spots) — while a cell is ghosted, cycle its own choices
function activeCellRots(aw) {
  const cell = armedCell || hoverCell;
  if (aw && aw.type === 'place-tile' && cell) {
    const [r, c] = cell.split(',').map(Number);
    const t = aw.targets.find(tg => tg.r === r && tg.c === c);
    if (t) return t.rots;
  }
  return legalRots(aw);
}

function rotatePreview(dir = 1) {
  const aw = state && state.awaiting;
  const rots = activeCellRots(aw);
  if (!rots.length) return;
  const i = rots.indexOf(previewRot);
  previewRot = rots[(i + dir + rots.length) % rots.length];
  render();
}

// ---------------------------------------------------------------- render

let knownWatchers = null; // for "X watches from the mist" arrival toasts

function noteWatchers() {
  const now = (room && room.watchers) || [];
  if (knownWatchers !== null && room && room.started) {
    for (const w of now) {
      if (!knownWatchers.includes(w)) toast(`${w} watches from the mist.`, true);
    }
  }
  knownWatchers = now;
}

function render() {
  if (!room) return;
  noteWatchers();
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
    armedCell = null; armedAction = null; hoverCell = null;
    livePreview = null; lastPreviewSent = ''; // a finalized/changed decision clears the live ghost
    const rots = legalRots(aw);
    previewRot = rots.includes(previewRot) ? previewRot : (rots[0] ?? 0);
    // soft turn timer: a fresh countdown for every decision
    const tt = room.config && room.config.turnTimer;
    decisionDeadline = (tt && aw && (state.phase === 'play' || state.phase === 'setup'))
      ? Date.now() + tt * 1000 : null;
    updateTimer();
    // idle auto-rest arms only for OUR post-move prompt (see idleEndTick)
    idleEndSig = (aw && aw.type === 'post-move' && state.phase === 'play' && isMine(aw.seat))
      ? awaitingSig : null;
    if (idleEndSig) lastInputAt = Date.now(); // full grace period per decision
  }

  renderTopbar();
  renderPlayers();
  renderSoul();
  renderDiscard();
  renderLog();
  renderBoard();
  renderLivePreview();
  renderActionBar();
  renderPreviewPanel();
  renderModal();
  maybeNiflheimAlert();
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
  room.seats.forEach(s => {
    const div = document.createElement('div');
    div.className = 'seat' + (s.claimed ? ' claimed' : '') + (s.you ? ' you' : '');
    const kick = room.youAreHost && s.claimed && !s.you
      ? `<button class="seat-kick" title="Release this soul">✕</button>` : '';
    const look = s.you
      ? `<button class="seat-look" title="Choose this soul's sigil and color">⚙ look</button>` : '';
    div.innerHTML = `<div class="seat-name" style="color:${s.color}">${sigilChip(s.icon, s.color, 20)} Soul ${s.seat + 1}${kick}</div>
      <div class="seat-sub">${s.claimed ? escapeHtml(s.name) + (s.you ? ' (you)' : '') : 'unclaimed — click to take'}${look}</div>`;
    div.onclick = () => send({ t: 'claim', seat: s.seat });
    const kb = div.querySelector('.seat-kick');
    if (kb) kb.onclick = (e) => { e.stopPropagation(); send({ t: 'kick', seat: s.seat }); };
    const lb = div.querySelector('.seat-look');
    if (lb) lb.onclick = (e) => { e.stopPropagation(); lookSeat = lookSeat === s.seat ? null : s.seat; render(); };
    list.appendChild(div);
  });
  renderLookPicker();
  const lw = $('lobby-watchers');
  const wnames = room.watchers || [];
  lw.classList.toggle('hidden', !wnames.length);
  lw.textContent = wnames.length
    ? `Watching from the mist: ${wnames.join(', ')} — release a soul and they can claim it.` : '';
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
    $('cfg-runePerks').checked = !!cfg.runePerks;
    $('cfg-gateExits').value = cfg.gateExits || 'one';
    $('cfg-turnTimer').value = String(cfg.turnTimer || 0);
  }
  const total = CFG_KEYS.reduce((n, k) => n + cfg[k], 0) + cfg.gateValhalla + cfg.gateFolkvangr;
  const gates = cfg.gateValhalla + cfg.gateFolkvangr;
  $('diff-summary').textContent =
    `${cfg.label || 'Custom'} — ${total} tiles · ${cfg.rune} rune circles · ${cfg.draugr} draugr · ${gates} gate${gates === 1 ? '' : 's'}`
    + (cfg.randomRunes ? ' · random runes' : '')
    + (cfg.runePerks ? ' · rune perks' : '')
    + (cfg.gateExits === 'straight' ? ' · two-door gates' : cfg.gateExits === 'tee' ? ' · three-door gates' : '')
    + (cfg.turnTimer ? ` · ${cfg.turnTimer}s timer` : '');
}

// the look picker: eight sigils and eight colors, no two souls alike —
// options another claimed seat wears are shown dimmed and locked
function renderLookPicker() {
  const lp = $('look-picker');
  const seat = lookSeat !== null ? room.seats[lookSeat] : null;
  if (!seat || !seat.you) {
    lookSeat = null;
    lp.classList.add('hidden');
    lp.innerHTML = '';
    return;
  }
  lp.classList.remove('hidden');
  const takenI = new Set(room.seats.filter(x => x.claimed && x.seat !== lookSeat).map(x => x.icon));
  const takenC = new Set(room.seats.filter(x => x.claimed && x.seat !== lookSeat).map(x => x.color));
  // each sigil button is a mini token in the soul's color — previews the real
  // token and lets any commissioned mark read on the disc
  lp.innerHTML = `<h4>Soul ${lookSeat + 1} — bear a sigil, wear a color</h4>
    <div class="look-row">${TOKEN_ICON_KEYS.map(k =>
      `<button class="look-btn${k === seat.icon ? ' sel' : ''}${takenI.has(k) ? ' taken' : ''}" data-icon="${k}"
        style="background:${takenI.has(k) ? '#3a4740' : seat.color}"
        title="${TOKEN_ICONS[k].name}${takenI.has(k) ? ' — borne by another soul' : ''}">${sigilHTML(k, '#0a100d', 22)}</button>`).join('')}</div>
    <div class="look-row">${PLAYER_COLORS.map((c, i) =>
      `<button class="look-swatch${c === seat.color ? ' sel' : ''}${takenC.has(c) ? ' taken' : ''}" data-color="${c}"
        style="background:${c}" title="${PLAYER_COLOR_NAMES[i]}${takenC.has(c) ? ' — worn by another soul' : ''}"></button>`).join('')}</div>`;
  lp.querySelectorAll('[data-icon]').forEach(b => {
    b.onclick = () => { if (!b.classList.contains('taken')) send({ t: 'look', seat: lookSeat, icon: b.dataset.icon }); };
  });
  lp.querySelectorAll('[data-color]').forEach(b => {
    b.onclick = () => { if (!b.classList.contains('taken')) send({ t: 'look', seat: lookSeat, color: b.dataset.color }); };
  });
}

function renderTopbar() {
  $('room-tag').textContent = room.code;
  const n = state.stackCount;
  // Raven-counsel (Ansuz): on the bearer's turn, the next tiles are known
  const peek = state.stackPeek && state.stackPeek.length
    ? ` <span class="peek" title="Raven-counsel: the next tiles of the stack">ᚨ next: ${state.stackPeek.map(t => t.kind === 'gate' ? `Gate of ${GATE_NAMES[t.gate]}` : t.kind === 'rune' ? 'Rune Circle' : t.kind).join(' · ')}</span>`
    : '';
  $('stack-meter').innerHTML = (state.niflheim
    ? `❄ <b>Niflheim’s Embrace</b> — the forest dwindles`
    : `Hope remaining: <b>${n}</b> tiles`) + peek;
  $('stack-meter').classList.toggle('embrace', !!state.niflheim);
  $('stack-meter').classList.toggle('low', !state.niflheim && n <= 10);
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
    'place-scramble': `${who} claws for footing${mine}`,
    'scramble': `${who} staggers clear${mine}`,
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
    // mid-game seat administration: adopt an abandoned soul; release your own
    // (to hand it to a watcher or teammate); the host may release anyone's
    const seatInfo = room.seats[p.seat];
    let admin = '';
    if (seatInfo && !seatInfo.claimed) {
      admin = `<button class="seat-admin" data-act="adopt" title="Take control of this abandoned soul">adopt</button>`;
    } else if (seatInfo && seatInfo.you) {
      admin = `<button class="seat-admin" data-act="release" title="Set this soul free for another player to adopt">✕</button>`;
    } else if (room.youAreHost && seatInfo && seatInfo.claimed && !seatInfo.you) {
      admin = `<button class="seat-admin" data-act="kick" title="Release this soul so another player can adopt it">✕</button>`;
    }
    div.innerHTML = `
      <div class="flame" style="background:${p.color}">${p.icon && TOKEN_ICONS[p.icon] ? sigilHTML(p.icon, '#0a100d', 16) : (p.name[0] || '?').toUpperCase()}</div>
      <div class="pinfo">
        <div class="pname">${p.name}${isMine(p.seat) ? ' ✦' : ''}${turnChip}</div>
        <div class="pstat">${status} · resolve <span class="resolve-pips">${'◆'.repeat(p.resolve)}${'◇'.repeat(Math.max(0, capOf(p) - p.resolve))}</span></div>
      </div>
      ${admin}${rune}`;
    div.onclick = () => { soulSeat = p.seat; selectTab('soul'); renderSoul(); };
    const ab = div.querySelector('.seat-admin');
    if (ab) ab.onclick = (e) => {
      e.stopPropagation();
      if (ab.dataset.act === 'adopt') send({ t: 'claim', seat: p.seat });
      else if (ab.dataset.act === 'release') confirmModal(`Set ${p.name}'s soul free? Anyone here — including a watcher — can adopt it, and you can take it back if no one does.`, () => send({ t: 'kick', seat: p.seat }));
      else confirmModal(`Release ${p.name}'s soul so another player can adopt it? Their player can rejoin and re-adopt it too.`, () => send({ t: 'kick', seat: p.seat }));
    };
    wrap.appendChild(div);
  });
  // the watchers in the mist: connected, registered, holding no soul
  const wl = $('watchers');
  const wnames = (room && room.watchers) || [];
  wl.classList.toggle('hidden', !wnames.length);
  wl.textContent = wnames.length ? `Watching from the mist: ${wnames.join(', ')}` : '';
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
      ? 'The ember of your hope lights the paths around you.'
      : 'The mist has swallowed your light.';
  const can = [], cant = [];
  if (p.falling) {
    can.push('Next turn: land on any empty, unlit space in the fallen rift’s row or column — a tile is drawn for you to land on.');
    can.push('You land with your <b>ember still lit</b> — you kindle the ways around where you land, as after any move.');
    cant.push('You light nothing while you fall.');
  } else if (p.hopeful) {
    can.push('You light every connected path one space around you (no diagonals).');
    can.push('Move along connected paths — new tiles are revealed at your open passages.');
    can.push('Stay to steel your Resolve (+1 ◆, max 2 — but hope gutters while you linger: a tile burns from the stack).');
    cant.push('Two souls never share a tile (Gates excepted).');
    cant.push('You cannot step onto a Draugr unless you go Berserk (1 ◆).');
  } else {
    can.push('You see only the tile you stand on.');
    can.push('You <b>must move</b> every turn — staying costs 1 ◆ (Endure).');
    can.push('Moving into the mist reveals only the single tile you step onto.');
    can.push('Rekindle: stand beside a hopeful soul on a connected path (automatic), or spend 1 ◆ at the start of your turn.');
    cant.push('You reveal no other paths while hopeless.');
    cant.push('Step carefully — a Draugr drawn beneath your feet strikes at once.');
  }
  const acts = [
    ['Press on', 'after your move, take another step (max twice a turn)', !p.falling],
    ['Rekindle', 'regain hope at the start of your turn', !p.hopeful],
    ['Endure', 'stay put while hopeless', !p.hopeful && !p.falling],
    ['Brace', 'lose 2 tiles instead of 3 when a Draugr strikes', true],
    ['Berserk', 'take a Draugr’s strike head-on to banish it from the forest', p.hopeful],
    ['Ward', 'skip Niflheim’s toll at the end of your turn', !!state.niflheim],
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
    if (state.runePerks && i.perk) {
      runeLine += `<br><small class="perk-line">✦ ${state.niflheim && i.winterPerk ? i.winterPerk : i.perk}</small>`;
    }
    // Deep vitality consent: the bearer opens or closes their purse (worker 'lend')
    if (state.runePerks && p.rune.k === 'uruz' && isMine(seat)) {
      runeLine += `<br><button class="btn tiny" id="lend-toggle">${p.lendOk === false
        ? 'Purse closed — tap to lend ◆ (ᚢ)' : 'Purse open — lending ◆ · tap to close (ᚢ)'}</button>`;
    }
  }
  el.innerHTML = `
    <div class="soul-card ${cls}">
      <div class="soul-head">
        <div class="flame" style="background:${p.color}">${p.icon && TOKEN_ICONS[p.icon] ? sigilHTML(p.icon, '#0a100d', 16) : (p.name[0] || '?').toUpperCase()}</div>
        <div>
          <div class="soul-name">${escapeHtml(p.name)}${isMine(seat) ? ' ✦' : ''}</div>
          <div class="pstat">resolve <span class="resolve-pips">${'◆'.repeat(p.resolve)}${'◇'.repeat(Math.max(0, capOf(p) - p.resolve))}</span></div>
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
  const lt = document.getElementById('lend-toggle');
  if (lt) lt.onclick = () => send({ t: 'lend', seat, on: p.lendOk === false });
}

function runeInfo(rune) {
  return RUNES[rune.p].find(r => r.k === rune.k);
}
// resolve cap: Deep vitality (Uruz, rune perks) lifts the bearer's to 3
const capOf = p => (state && state.runePerks && p.rune && p.rune.k === 'uruz' ? 3 : 2);

function renderDiscard() {
  const d = state.discard;
  const count = kind => d.filter(t => t.kind === kind).length;
  const gates = d.filter(t => t.kind === 'gate').map(t => GATE_NAMES[t.gate]);
  const tot = state.tileTotals || {};
  const den = k => tot[k] !== undefined ? `/${tot[k]}` : '';
  $('discard-counts').innerHTML = `
    <span class="d-item">paths <b>${count('straight') + count('tee') + count('cross') + count('start')}</b></span>
    <span class="d-item ${count('rune') ? 'bad' : ''}">rune circles <b>${count('rune')}</b>${den('rune')}</span>
    <span class="d-item">draugar <b>${count('draugr')}</b>${den('draugr')}</span>
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
      const sigSize = ps.length === 1 ? 19 : 14;
      const mark = p.icon && (art['sigil-' + p.icon] || TOKEN_ICONS[p.icon])
        ? sigilMark(p.icon, cx + ox - sigSize / 2, cy + oy - sigSize / 2, sigSize)
        : `<text x="${cx + ox}" y="${cy + oy + 4.5}" text-anchor="middle" font-size="${ps.length === 1 ? 14 : 11}" fill="#0a100d" font-weight="bold" font-family="Georgia">${(p.name[0] || '?').toUpperCase()}</text>`;
      const body = tokenArt
        ? `<image href="${tokenArt}" x="${cx + ox - R}" y="${cy + oy - R}" width="${R * 2}" height="${R * 2}"/>`
        : `<circle cx="${cx + ox}" cy="${cy + oy}" r="${ps.length === 1 ? 15 : 11}" fill="${p.color}" stroke="#0a100d" stroke-width="2"/>
           ${glow}
           ${mark}`;
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
  else if (aw && aw.type === 'fall-landing' && state.phase === 'play') {
    // spectators watch the fall: the tumbling soul's landing options glow in
    // their color for the whole table — visible to everyone, clickable by nobody
    const fp = state.players[aw.seat];
    for (const o of aw.options) {
      const x = PAD + o.c * CS, y = PAD + o.r * CS;
      parts.push(`<rect x="${x + 4}" y="${y + 4}" width="${CS - 8}" height="${CS - 8}" rx="8" class="watch-fall" style="stroke:${fp.color}"/>`);
    }
  }
  svg.classList.toggle('my-turn', !!myDecision);

  parts.push('<g id="ghost-layer" class="ghost"></g>');
  parts.push('<g id="live-layer" class="live-ghost"></g>');
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

  // ghost preview: on desktop it follows the pointer across placement targets
  if (!IS_COARSE) {
    svg.querySelectorAll('[data-hover]').forEach(el => {
      el.addEventListener('mouseenter', () => { hoverCell = el.getAttribute('data-hover'); updateGhost(); });
    });
    svg.onmouseleave = () => { hoverCell = null; updateGhost(); };
  }
  updateGhost();
}

// Draw the pending tile, semi-transparent, in the cell it would occupy — at
// the rotation that will actually be used there (snapped to fit the paths).
function updateGhost() {
  const layer = document.getElementById('ghost-layer');
  if (!layer) return;
  const aw = state && state.awaiting;
  let cell = null, rots = null, tile = null;
  if (aw && isMine(aw.seat)) {
    if (aw.type === 'place-blind' || aw.type === 'place-landing' || aw.type === 'place-scramble') {
      cell = `${aw.r},${aw.c}`; rots = aw.rots || [0, 1, 2, 3]; tile = aw.tile;
    } else if (aw.type === 'place-tile') {
      cell = armedCell || hoverCell;
      if (cell) {
        const [r, c] = cell.split(',').map(Number);
        const t = aw.targets.find(tg => tg.r === r && tg.c === c);
        if (t) { rots = t.rots; tile = aw.tile; } else cell = null;
      }
    } else if (aw.type === 'place-start') {
      cell = armedCell || hoverCell;
      rots = [0, 1, 2, 3]; tile = { kind: 'start', fractured: true };
    }
  }
  if (!cell || !tile) { layer.innerHTML = ''; broadcastPreview(); return; }
  const [r, c] = cell.split(',').map(Number);
  const rot = rots.includes(previewRot) ? previewRot : rots[0];
  const x = PAD + c * CS, y = PAD + r * CS;
  const ex = exitsFor(tile.kind, rot);
  layer.innerHTML = tileSVG({ ...tile, rot, exits: ex }, x, y)
    + exitMarkers(ex, x, y)
    + `<rect x="${x + 3}" y="${y + 3}" width="${CS - 6}" height="${CS - 6}" rx="8" class="ghost-outline"/>`;
  broadcastPreview();
}

// the active player relays their pending placement (cell + rotation) to the
// server, which fans it out to everyone else. Deduped by signature so a still
// hand doesn't spam the socket; the cell is null while nothing is hovered.
function broadcastPreview() {
  const aw = state && state.awaiting;
  const placement = aw && ['place-start', 'place-tile', 'place-blind', 'place-landing', 'place-scramble'].includes(aw.type);
  if (!placement || !isMine(aw.seat)) return;
  let cell;
  if (aw.type === 'place-blind' || aw.type === 'place-landing' || aw.type === 'place-scramble') cell = `${aw.r},${aw.c}`;
  else cell = armedCell || hoverCell;
  const sig = `${cell || 'none'}:${previewRot}`;
  if (sig === lastPreviewSent) return;
  lastPreviewSent = sig;
  const [r, c] = cell ? cell.split(',').map(Number) : [null, null];
  send({ t: 'preview', r, c, rot: previewRot });
}

// onlookers & watchers: draw the active player's pending tile where they're
// hovering it, in their colour, clearly labelled so no one mistakes it for
// their own turn. Fed by relayed 'preview' messages; empty for the active soul.
function renderLivePreview() {
  const layer = document.getElementById('live-layer');
  if (!layer) return;
  const aw = state && state.awaiting;
  const placement = aw && ['place-start', 'place-tile', 'place-blind', 'place-landing', 'place-scramble'].includes(aw.type);
  if (!livePreview || !placement || isMine(aw.seat) || livePreview.seat !== aw.seat
      || livePreview.r == null || livePreview.c == null) {
    layer.innerHTML = '';
    return;
  }
  const p = state.players[livePreview.seat];
  const tile = aw.type === 'place-start' ? { kind: 'start', fractured: true } : aw.tile;
  if (!tile) { layer.innerHTML = ''; return; }
  const rot = livePreview.rot || 0;
  const { r, c } = livePreview;
  const x = PAD + c * CS, y = PAD + r * CS;
  const ex = exitsFor(tile.kind, rot);
  const cx = x + CS / 2;
  const name = (p.name || '?').slice(0, 14);
  const chipW = Math.max(40, name.length * 6 + 14);
  const chipY = r === 0 ? y + CS + 3 : y - 19;
  layer.innerHTML = tileSVG({ ...tile, rot, exits: ex }, x, y)
    + `<rect x="${x + 3}" y="${y + 3}" width="${CS - 6}" height="${CS - 6}" rx="8" fill="none" stroke="${p.color}" stroke-width="3" stroke-dasharray="7 5"/>`
    + `<g><rect x="${cx - chipW / 2}" y="${chipY}" width="${chipW}" height="16" rx="8" fill="${p.color}"/>`
    + `<text x="${cx}" y="${chipY + 11.5}" text-anchor="middle" font-size="9.5" fill="#0a100d" font-family="Georgia">${escapeHtml(name)}</text></g>`;
}

function hlRect(x, y, cls) {
  return `<rect x="${x + 4}" y="${y + 4}" width="${CS - 8}" height="${CS - 8}" rx="8" class="hl ${cls}"/>`;
}
function clickRect(parts, r, c, cls, handler, hoverId) {
  const x = PAD + c * CS, y = PAD + r * CS;
  const id = `${r},${c},${cls}`;
  parts.push(hlRect(x, y, cls));
  parts.push(`<rect x="${x}" y="${y}" width="${CS}" height="${CS}" fill="transparent" class="clickable" ${hoverId ? `data-hover="${hoverId}" ` : ''}data-click="${id}"/>`);
  clickMap.set(id, handler);
}

// A placement target. Desktop: hovering ghosts the tile in the cell at the
// rotation that will actually be used (snapped to fit), and a click places it.
// Touch: the first tap ghosts it, a second tap (or ✓ Place) confirms.
function placeRect(parts, r, c, rots, put) {
  const id = `${r},${c}`;
  const confirm = () => put(rots.includes(previewRot) ? previewRot : rots[0]);
  clickRect(parts, r, c, 'place', () => {
    if (IS_COARSE && armedCell !== id) {
      armedCell = id;
      if (!rots.includes(previewRot)) previewRot = rots[0];
      armedAction = confirm;
      render();
      return;
    }
    confirm();
  }, id);
}

function addInteractions(parts, aw) {
  switch (aw.type) {
    case 'place-start': {
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
        if (!state.grid[key(r, c)]) placeRect(parts, r, c, [0, 1, 2, 3], rot => act({ r, c, rot }));
      }
      break;
    }
    case 'place-tile': {
      // every legal spot glows; the rotation snaps to fit the spot you pick
      aw.targets.forEach(t => placeRect(parts, t.r, t.c, t.rots, rot => act({ r: t.r, c: t.c, rot })));
      break;
    }
    case 'place-blind':
    case 'place-landing':
    case 'place-scramble': {
      // single known spot: the ghost already shows in place — a tap confirms it
      clickRect(parts, aw.r, aw.c, 'place', () => act({ rot: previewRot }));
      break;
    }
    case 'action': {
      aw.moves.forEach(m => {
        clickRect(parts, m.r, m.c, m.kind, () => {
          if (m.kind === 'charge') {
            confirmModal('Go berserk and rush the Draugr? Its strike WILL land on you — but with its spite spent, it is banished from the forest. (1 Resolve)', () => act({ kind: 'move', d: m.d }));
          } else if (m.kind === 'cross') {
            confirmModal(`Stride across the Void Rift to the far side?${m.cost ? ' (1 Resolve — Wayfarer ᚱ)' : ' (The last road ᚱ)'}`, () => act({ kind: 'move', d: m.d, cross: true }));
          } else if (m.kind === 'jump') {
            confirmModal('Leap into the Void Rift? You will fall, and land next turn with your ember still lit.', () => act({ kind: 'move', d: m.d }));
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
              confirmModal('Go berserk and rush the Draugr? Its strike WILL land on you, then it is banished. (2 Resolve in total)', () => act({ kind: 'move', d: m.d }));
            } else if (m.kind === 'cross') {
              confirmModal(`Stride across the Void Rift?${m.cost ? ' (1 Resolve — Wayfarer ᚱ)' : ''}`, () => act({ kind: 'move', d: m.d, cross: true }));
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

// a jagged woodcut pine: tall ink spike with a skirt tier and one pale
// rim-light stroke, base tier centered at (px, py)
function pine(px, py, s, fill) {
  return `<path d="M ${px - s * 0.62} ${py} L ${px} ${py - s * 2} L ${px + s * 0.62} ${py}
    L ${px + s * 0.38} ${py} L ${px + s * 0.7} ${py + s * 0.9} L ${px - s * 0.7} ${py + s * 0.9} L ${px - s * 0.38} ${py} Z" fill="${fill}"/>
    <path d="M ${px} ${py - s * 2} L ${px + s * 0.62} ${py}" stroke="#3f4c3c" stroke-width="0.9" opacity="0.55" fill="none"/>`;
}

// a pair of small cairn stones, ink-edged
function cairn(px, py) {
  return `<path d="M ${px - 5} ${py} l 5 -3 l 2 5 l -6 2 z" fill="#2e372e" stroke="#0d120d" stroke-width="0.8"/>
    <path d="M ${px + 1} ${py + 2} l 4 -2 l 1 4 l -5 1 z" fill="#283028" stroke="#0d120d" stroke-width="0.8"/>`;
}

// bright chevrons at each open passage — near-black woodcut tiles are hard
// to read at phone sizes, so pending tiles (preview panel + board ghost)
// wear their openings on their sleeve
function exitMarkers(exits, x, y) {
  const cx = x + CS / 2, cy = y + CS / 2;
  const pts = [[cx, y + 9, 0], [x + CS - 9, cy, 90], [cx, y + CS - 9, 180], [x + 9, cy, 270]];
  let out = '';
  for (let d = 0; d < 4; d++) {
    if (!exits[d]) continue;
    const [mx, my, rot] = pts[d];
    out += `<path d="M ${mx - 5.5} ${my + 3} L ${mx} ${my - 3.5} L ${mx + 5.5} ${my + 3}" fill="none" stroke="#e8b23c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" transform="rotate(${rot} ${mx} ${my})" opacity="0.95"/>`;
  }
  return out;
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
  // ink-black ground with sparse woodcut hatching
  parts.push(`<rect x="${x + 2.5}" y="${y + 2.5}" width="${CS - 5}" height="${CS - 5}" rx="7" fill="url(#mk-ground)" stroke="#465046" stroke-width="1"/>`);
  parts.push(`<g stroke="#131a12" stroke-width="1" fill="none">
    <path d="M ${x + 9 + (seed % 8)} ${y + 20 + (seed % 6)} h11 M ${x + 7 + (seed % 8)} ${y + 24 + (seed % 6)} h7
      M ${x + 58 - (seed % 7)} ${y + 62 + (seed % 6)} h10 M ${x + 62 - (seed % 7)} ${y + 66 + (seed % 6)} h8"/></g>`);
  // seeded corner growth: jagged pines or cairn stones
  const corners = [[x + 14, y + 24], [x + CS - 14, y + 25], [x + 14, y + CS - 16], [x + CS - 14, y + CS - 15]];
  corners.forEach(([px, py], i) => {
    if ((seed >> i) & 1) parts.push(pine(px, py, 8.5, '#060a06'));
    else parts.push(cairn(px, py));
  });
  // packed-earth tracks: cart-grooved, lined with cairn stones on the verges
  const ends = [[cx, y + 2.5], [x + CS - 2.5, cy], [cx, y + CS - 2.5], [x + 2.5, cy]];
  for (let d = 0; d < 4; d++) {
    if (!exits[d]) continue;
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${ends[d][0]}" y2="${ends[d][1]}" stroke="#262019" stroke-width="24"/>`);
  }
  if (exits.some(Boolean)) parts.push(`<circle cx="${cx}" cy="${cy}" r="12.5" fill="#29231a"/>`);
  for (let d = 0; d < 4; d++) {
    if (!exits[d]) continue;
    const [ex, ey] = ends[d];
    const vert = d % 2 === 0;
    // pale ink verge lines: they run WITH the track, so open mouths stay
    // visibly open and the road reads even at phone sizes
    for (const off of [-12, 12]) {
      const px2 = vert ? off : 0, py2 = vert ? 0 : off;
      parts.push(`<line x1="${cx + (ex - cx) * 0.24 + px2}" y1="${cy + (ey - cy) * 0.24 + py2}" x2="${ex + px2}" y2="${ey + py2}" stroke="#59644f" stroke-width="1.1" opacity="0.9"/>`);
    }
    for (const off of [-4, 4]) {
      const gx = vert ? off : 0, gy = vert ? 0 : off;
      parts.push(`<line x1="${cx + gx}" y1="${cy + gy}" x2="${ex + gx}" y2="${ey + gy}" stroke="#120e09" stroke-width="1.6"/>`);
    }
    for (const side of [-1, 1]) {
      const f = 0.55 + (((seed >> (d + (side > 0 ? 2 : 0))) & 3) * 0.09);
      const sx = cx + (ex - cx) * f + (vert ? side * 15 : 0);
      const sy = cy + (ey - cy) * f + (vert ? 0 : side * 15);
      const tone = ((seed >> d) & 1) ? '#2e372e' : '#283028';
      parts.push(`<path d="M ${sx - 3} ${sy + 2} l 5 -4 l 2.5 4.5 l -6 2.5 z" fill="${tone}" stroke="#0d120d" stroke-width="0.8"/>`);
    }
  }

  // kind decorations
  if (tile.kind === 'start') {
    // a broad cleared opening in the wood — the wide chamber where the soul
    // awoke, its two ways out cut through the treeline
    parts.push(`<path d="M ${cx + 32} ${cy - 5} C ${cx + 35} ${cy + 12} ${cx + 22} ${cy + 30} ${cx + 3} ${cy + 32} C ${cx - 15} ${cy + 34} ${cx - 31} ${cy + 22} ${cx - 33} ${cy + 4} C ${cx - 35} ${cy - 13} ${cx - 24} ${cy - 29} ${cx - 5} ${cy - 32} C ${cx + 13} ${cy - 35} ${cx + 30} ${cy - 22} ${cx + 32} ${cy - 5} Z" fill="#262019" stroke="#59644f" stroke-width="1"/>`);
    for (let d = 0; d < 4; d++) {
      if (!exits[d]) continue;
      const [ex, ey] = ends[d];
      parts.push(`<line x1="${cx + (ex - cx) * 0.68}" y1="${cy + (ey - cy) * 0.68}" x2="${ex}" y2="${ey}" stroke="#262019" stroke-width="24"/>`);
      for (const off of [-4, 4]) {
        const gx = d % 2 === 0 ? off : 0, gy = d % 2 === 0 ? 0 : off;
        parts.push(`<line x1="${cx + (ex - cx) * 0.8 + gx}" y1="${cy + (ey - cy) * 0.8 + gy}" x2="${ex + gx}" y2="${ey + gy}" stroke="#120e09" stroke-width="1.6"/>`);
      }
    }
    parts.push(`<path d="M ${x + 18} ${y + 58} h 8 M ${x + 62} ${y + 26} h 7" stroke="#171209" stroke-width="1" fill="none"/>`);
    // a cold campfire at the heart of the clearing
    parts.push(`<circle cx="${cx}" cy="${cy}" r="13" fill="url(#mk-ember)"/>`);
    parts.push(`<rect x="${cx - 7.5}" y="${cy - 1.6}" width="15" height="3.2" rx="1.6" fill="#4a3a28" transform="rotate(28 ${cx} ${cy})"/>`);
    parts.push(`<rect x="${cx - 7.5}" y="${cy - 1.6}" width="15" height="3.2" rx="1.6" fill="#57432c" transform="rotate(-38 ${cx} ${cy})"/>`);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + (seed % 7) * 0.3;
      parts.push(`<circle cx="${cx + Math.cos(a) * 11.5}" cy="${cy + Math.sin(a) * 11.5}" r="2.5" fill="#39443a" stroke="#10150f" stroke-width="0.8"/>`);
    }
  } else if (tile.kind === 'rune') {
    // standing stones at the diagonals around a ritual ring
    parts.push(`<circle cx="${cx}" cy="${cy}" r="12" fill="url(#mk-gold)" opacity="0.55"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="19" fill="none" stroke="#d8c27a" stroke-width="1.6" stroke-dasharray="5 4" opacity="0.85"/>`);
    const stones = [[-18, -18], [18, -18], [-18, 18], [18, 18]];
    const glyphs = ['ᚠ', 'ᚢ', 'ᛃ', 'ᛜ'];
    stones.forEach(([sx, sy], i) => {
      parts.push(`<path d="M ${cx + sx - 5.5} ${cy + sy + 8} l 1.6 -13.5 q 4 -4.5 7.8 0 l 1.6 13.5 z" fill="url(#mk-stone)" stroke="#10150f" stroke-width="1"/>`);
      parts.push(`<text x="${cx + sx}" y="${cy + sy + 4}" text-anchor="middle" font-size="7.5" fill="#e8d9a0" font-family="Georgia" opacity="0.95">${glyphs[i]}</text>`);
    });
    parts.push(`<text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="17" fill="#efe0a8" font-family="Georgia">ᚱ</text>`);
  } else if (tile.kind === 'gate') {
    // the whole monument rotates with the tile so the doorway faces its passage
    const rot = (tile.rot || 0) * 90;
    const col = tile.gate === 'valhalla' ? '#e8b23c' : '#6fce9a';
    const glowId = tile.gate === 'valhalla' ? 'mk-gold' : 'mk-green';
    const g1 = tile.gate === 'valhalla' ? 'ᛞ' : 'ᛒ'; // thurisaz retired; the dawn-rune marks Valgrind
    const g2 = tile.gate === 'valhalla' ? 'ᚱ' : 'ᚹ';
    parts.push(`<g transform="rotate(${rot} ${cx} ${cy})">
      <ellipse cx="${cx}" cy="${cy - 6}" rx="27" ry="24" fill="url(#${glowId})"/>
      <rect x="${cx - 13}" y="${y + 5}" width="26" height="5" rx="1.5" fill="#4a4438"/>
      <rect x="${cx - 16}" y="${y + 10}" width="32" height="4" rx="1.5" fill="#3c372e"/>
      <ellipse cx="${cx}" cy="${cy - 3}" rx="11" ry="15" fill="url(#${glowId})"/>
      <rect x="${cx - 21}" y="${cy - 12}" width="8" height="28" rx="2" fill="url(#mk-stone)" stroke="#10150f" stroke-width="1"/>
      <rect x="${cx + 13}" y="${cy - 12}" width="8" height="28" rx="2" fill="url(#mk-stone)" stroke="#10150f" stroke-width="1"/>
      <rect x="${cx - 23}" y="${cy - 16}" width="12" height="5" rx="1.5" fill="#39443a" stroke="#10150f" stroke-width="0.8"/>
      <rect x="${cx + 11}" y="${cy - 16}" width="12" height="5" rx="1.5" fill="#39443a" stroke="#10150f" stroke-width="0.8"/>
      <path d="M ${cx - 22} ${cy - 13} Q ${cx} ${cy - 37} ${cx + 22} ${cy - 13}" fill="none" stroke="${col}" stroke-width="5.5"/>
      <path d="M ${cx - 4} ${cy - 28} l 4 -5.5 l 4 5.5 l -4 5.5 z" fill="${col}"/>
      <text x="${cx - 17}" y="${cy + 2}" text-anchor="middle" font-size="7" fill="#1c2a22" font-family="Georgia">${g1}</text>
      <text x="${cx + 17}" y="${cy + 2}" text-anchor="middle" font-size="7" fill="#1c2a22" font-family="Georgia">${g2}</text>
    </g>`);
    parts.push(`<text x="${cx}" y="${y + CS - 8}" text-anchor="middle" font-size="9.5" fill="${col}" font-family="Georgia" letter-spacing="1.5">${tile.gate === 'valhalla' ? 'VALHALLA' : 'FÓLKVANGR'}</text>`);
  } else if (tile.kind === 'draugr') {
    // a gaunt ink silhouette in a broken crown — one pale gleam where a face
    // should be, frost creeping out from under its feet
    parts.push(`<g>
      <g stroke="#a9b295" opacity="0.3" stroke-width="1" fill="none">
        <path d="M ${cx} ${cy + 21} l -9 6 M ${cx} ${cy + 21} l 9 6 M ${cx} ${cy + 21} l -3 9 M ${cx} ${cy + 21} l 3 9"/>
      </g>
      <path d="M ${cx} ${cy - 29} C ${cx - 4} ${cy - 29} ${cx - 6} ${cy - 25} ${cx - 6} ${cy - 21} C ${cx - 6} ${cy - 18} ${cx - 5} ${cy - 16} ${cx - 3} ${cy - 15} C ${cx - 9} ${cy - 12} ${cx - 11} ${cy - 4} ${cx - 11} ${cy + 5} L ${cx - 13} ${cy + 21} L ${cx - 7} ${cy + 15} L ${cx - 4} ${cy + 22} L ${cx} ${cy + 16} L ${cx + 4} ${cy + 22} L ${cx + 7} ${cy + 15} L ${cx + 13} ${cy + 21} L ${cx + 11} ${cy + 5} C ${cx + 11} ${cy - 4} ${cx + 9} ${cy - 12} ${cx + 3} ${cy - 15} C ${cx + 5} ${cy - 16} ${cx + 6} ${cy - 18} ${cx + 6} ${cy - 21} C ${cx + 6} ${cy - 25} ${cx + 4} ${cy - 29} ${cx} ${cy - 29} Z" fill="#050705"/>
      <path d="M ${cx - 5} ${cy - 28} l -2 -6 l 4 3 l 3 -7 l 3 7 l 4 -3 l -2 6" fill="none" stroke="#050705" stroke-width="2.2"/>
      <path d="M ${cx - 4} ${cy - 5} l -2 12 M ${cx + 4} ${cy - 3} l 2 10" stroke="#10150f" stroke-width="1"/>
      <path d="M ${cx - 3.5} ${cy - 20.5} l 7 -1.5" stroke="#cbd0b4" stroke-width="1.6">${sm('<animate attributeName="opacity" values="1;0.3;1" dur="3.2s" repeatCount="indefinite"/>')}</path>
    </g>`);
  }

  // fracture cracks — the void already seeping through
  if (tile.fractured) parts.push(crackSVG(x, y));
  return parts.join('');
}

function crackSVG(x, y) {
  // the tile is breaking apart: a long branching fissure with the Void's
  // violet light seeping through, chipped edges, loose shards
  const main = `M ${x + 14} ${y + 8} l 8 9 l -4 7 l 11 8 l -3 8 l 11 7 l -2 10 l 8 6`;
  const branches = `M ${x + 22} ${y + 17} l 8 -4 M ${x + 29} ${y + 32} l -9 4 M ${x + 37} ${y + 47} l 10 -5 M ${x + 45} ${y + 63} l -8 4`;
  const second = `M ${x + CS - 10} ${y + CS - 30} l -9 6 l 2 7 l -8 5`;
  return `<g>
    <g stroke="#584086" fill="none" stroke-linecap="round" opacity="0.5">
      <path d="${main}" stroke-width="5"/><path d="${second}" stroke-width="4"/>
      ${sm('<animate attributeName="opacity" values="0.5;0.2;0.5" dur="3.6s" repeatCount="indefinite"/>')}
    </g>
    <path d="${main}" stroke="#050308" stroke-width="2.4" fill="none"/>
    <path d="${second}" stroke="#050308" stroke-width="2" fill="none"/>
    <path d="${branches}" stroke="#050308" stroke-width="1.2" fill="none"/>
    <path d="M ${x + 30} ${y + 26} l 5 2 l -4 3 z M ${x + 41} ${y + 55} l 5 1 l -3 4 z" fill="#0a0d09" stroke="#3f4c3c" stroke-width="0.5"/>
    <path d="M ${x + 36} ${y + 2} l 7 0 l -3.5 4.5 z M ${x + CS - 2} ${y + 30} l 0 7 l -4.5 -3.5 z M ${x + 20} ${y + CS - 2} l 7 0 l -3.5 -4.5 z" fill="#050705"/>
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
      + pine(x + 16 + (seed % 9), y + CS - 14, 9, '#0e130e');
  }
  // deep mist: barely-there trees swallowed by fog
  return `<rect x="${x + 1}" y="${y + 1}" width="${CS - 2}" height="${CS - 2}" rx="6" class="cell-mist"/>`
    + pine(x + 18 + (seed % 14), y + 34, 13, '#0a0f0a')
    + pine(x + CS - 24 - (seed % 10), y + CS - 13, 12, '#080c08')
    + `<g opacity="0.5">
        <ellipse cx="${x + 30 + (seed % 20)}" cy="${y + 38}" rx="26" ry="9" fill="#222b22" opacity="0.12"/>
        <ellipse cx="${x + 56 - (seed % 16)}" cy="${y + 64}" rx="24" ry="8" fill="#222b22" opacity="0.14"/>
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
    case 'place-start':
    case 'place-tile':
    case 'place-blind':
    case 'place-landing':
    case 'place-scramble': {
      const texts = {
        'place-start': IS_COARSE
          ? 'Tap a clearing to preview your awakening — tap it again to settle'
          : 'Choose any dark clearing to awaken in',
        'place-tile': IS_COARSE
          ? 'Tap a glowing space to preview the tile — tap it again to place'
          : 'Place the revealed tile on a glowing space',
        'place-blind': IS_COARSE
          ? 'Turn the tile you feel beneath you, then ✓ Place'
          : 'Turn the tile you feel beneath you (R), then click it',
        'place-landing': IS_COARSE
          ? 'Turn your landing to fit, then ✓ Place'
          : 'Turn your landing to fit (R), then click it',
        'place-scramble': IS_COARSE
          ? 'Turn the tile you clutch at, then ✓ Place'
          : 'Turn the tile you clutch at (R), then click it',
      };
      note(texts[aw.type]);
      if (IS_COARSE) {
        if (activeCellRots(aw).length > 1) btn('⟳ Rotate', () => rotatePreview());
        const single = aw.type !== 'place-start' && aw.type !== 'place-tile';
        if (single) btn('✓ Place', () => act({ rot: previewRot }), 'primary');
        else if (armedCell && armedAction) btn('✓ Place here', () => armedAction(), 'primary');
      }
      break;
    }
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
        btn(moveAgainArmed ? 'Cancel move' : (aw.freeStep ? 'Press on <small>(free — ᛇ)</small>' : 'Press on <small>(1 ◆)</small>'), () => {
          moveAgainArmed = !moveAgainArmed;
          render();
        });
        if (moveAgainArmed) note('click a glowing space');
      }
      break;
    }
    case 'swap-draugr': note('The Draugr must take a connected path — choose which'); break;
    case 'fall-landing': note('Choose where to fall back into Myrkviðr (along the rift’s row or column)'); break;
    case 'scramble': note('Find your footing — choose an adjacent space'); break;
    case 'niflheim': {
      if (aw.canRefuse) btn('Refuse the cold <small>(once — ᚨ)</small>', () => act({ refuse: true }));
      if (aw.canSustain) btn('Ward <small>(1 ◆)</small>', () => act({ sustain: true }));
      note('Niflheim claims a tile — click one to surrender it');
      break;
    }
  }
}

// ---------------------------------------------------------------- preview panel

function renderPreviewPanel() {
  const aw = state.awaiting;
  const types = ['place-start', 'place-tile', 'place-blind', 'place-landing', 'place-scramble'];
  const isPlacement = aw && types.includes(aw.type);
  const mine = isPlacement && isMine(aw.seat);
  const watching = isPlacement && !mine;   // out-of-turn player or spectator, following along
  $('preview').classList.toggle('hidden', !isPlacement);
  $('preview').classList.toggle('watching', !!watching);
  if (!isPlacement) return;
  // the active player turns their own tile; watchers see it at the rotation the
  // active player is relaying
  const rot = mine ? previewRot : (livePreview && livePreview.seat === aw.seat ? (livePreview.rot || 0) : 0);
  const tile = aw.type === 'place-start'
    ? { kind: 'start', fractured: true, rot }
    : { ...aw.tile, rot };
  tile.exits = exitsFor(tile.kind, rot);
  $('preview-svg').innerHTML = tileSVG(tile, 1, 1) + exitMarkers(tile.exits, 1, 1); // draws at 90 within 92 viewbox
  if (mine) {
    $('preview-title').textContent = tileName(tile);
    const rots = activeCellRots(aw);
    $('rotate-btn').style.display = rots.length > 1 ? '' : 'none';
    $('rotate-btn').innerHTML = IS_COARSE ? '⟳ Rotate' : '⟳ Rotate <small>(R)</small>';
    $('preview-hint').textContent = rots.length > 1
      ? (IS_COARSE ? 'Tap the tile to turn it' : 'Click tile · R · scroll to turn')
      : 'Only one way fits';
  } else {
    const p = state.players[aw.seat];
    $('preview-title').innerHTML = `<span style="color:${p.color}">◈</span> ${escapeHtml(seatName(aw.seat))} is placing`;
    $('rotate-btn').style.display = 'none';
    $('preview-hint').textContent = tileName(tile);
  }
}

function tileName(tile) {
  return {
    start: 'Forest clearing', straight: 'Straight path', tee: 'Forking path',
    cross: 'Crossroads', rune: 'Rune Circle', draugr: 'Draugr',
    gate: tile.gate ? `Gate of ${GATE_NAMES[tile.gate]}` : 'Gate',
  }[tile.kind] + (tile.fractured ? ' (fractured)' : '');
}

// ---------------------------------------------------------------- niflheim alert

// Niflheim's Embrace is the saga's hard turning point — announce it once,
// full-screen, to every player. Each player dismisses it for themselves;
// the dismissal is remembered per saga so a mid-embrace reload doesn't nag.
function maybeNiflheimAlert() {
  if (!room || !state) return;
  const k = 'mk-nifl-' + room.code;
  const active = !!state.niflheim && state.phase === 'play';
  if (!state.niflheim) localStorage.removeItem(k); // fresh saga: arm the alert again
  const show = active && localStorage.getItem(k) !== 'seen';
  $('niflheim-overlay').classList.toggle('hidden', !show);
}
$('niflheim-close').onclick = () => {
  if (room) localStorage.setItem('mk-nifl-' + room.code, 'seen');
  $('niflheim-overlay').classList.add('hidden');
};

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

  // VICTORY FANFARE: winning is rare and hard-earned — it must never read like
  // the loss screen at a glance. A golden backdrop wash (#modal.victory) +
  // rising embers behind the card; both drop instantly on any other modal
  // (incl. the leave-confirm) and under Animations: off the static gold
  // styling still carries the message.
  const isWin = !modalLock && state && state.phase === 'won';
  const isLoss = !modalLock && state && state.phase === 'lost';
  modal.classList.toggle('victory', !!isWin);
  // the fanfare wears the winning gate's light: Valhalla gold, Fólkvangr green —
  // and defeat fades to the mist's red, with falling ash in place of embers
  modal.classList.toggle('folkvangr', !!isWin && state.winnerGate === 'folkvangr');
  modal.classList.toggle('defeat', !!isLoss);
  // the endgame card renders ONCE per outcome (see the endgame branch): any other
  // modal content invalidates the guard so a later endgame render rebuilds fresh
  if (modalLock || !state || (state.phase !== 'won' && state.phase !== 'lost')) {
    delete card.dataset.endgame;
  }
  const oldEmbers = modal.querySelector('#end-embers');
  if (!isWin && !isLoss && oldEmbers) oldEmbers.remove();
  if ((isWin || isLoss) && anims && !oldEmbers) {
    const em = document.createElement('div');
    em.id = 'end-embers';
    const n = isWin ? 26 : 14;             // ash is sparser than celebration
    const slow = isWin ? 0 : 3;            // ...and drifts, rather than dances
    for (let i = 0; i < n; i++) {
      const sp = document.createElement('span');
      const sz = (3 + Math.random() * 4).toFixed(1);
      sp.style.cssText = `left:${(Math.random() * 100).toFixed(1)}%;width:${sz}px;height:${sz}px;`
        + `--dx:${(Math.random() * 120 - 60).toFixed(0)}px;`
        + `animation-duration:${(4 + slow + Math.random() * 5).toFixed(1)}s;animation-delay:${(Math.random() * 6).toFixed(1)}s`;
      em.appendChild(sp);
    }
    modal.insertBefore(em, card);
  }

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
    // render once: a room rebroadcast (join/leave/kick) mid-celebration must not
    // restart the choreographed wash -> card -> title -> souls sequence
    const endSig = state.phase + ':' + (state.winnerGate || '') + ':' + (room.youAreHost ? 'h' : 'g');
    if (card.dataset.endgame === endSig) { modal.classList.remove('hidden'); return; }
    card.dataset.endgame = endSig;
    if (win) {
      // the gate's own glyph (Ansuz for Valhalla, Fehu for Fólkvangr), the four
      // souls with the runes they bore, and the saga's numbers — a win this
      // hard deserves to be shown, not implied
      const gglyph = state.winnerGate === 'valhalla' ? 'ᚨ' : 'ᚠ';
      const souls = state.players.map((q, i) => {
        const info = q.rune && RUNES[q.rune.p] ? RUNES[q.rune.p].find(rn => rn.k === q.rune.k) : null;
        const mark = q.icon && TOKEN_ICONS[q.icon]
          ? sigilHTML(q.icon, '#0a100d', 16)
          : (q.name[0] || '?').toUpperCase();
        return `<span class="vic-soul" style="animation-delay:${(3.1 + i * 0.18).toFixed(2)}s" title="${escapeHtml(q.name)}">
          <span class="vic-disc" style="background:${q.color}">${mark}</span>
          <span class="vic-rune">${info ? info.g : ''}</span></span>`;
      }).join('');
      const flavor = state.winnerGate === 'valhalla'
        ? 'The four runes blaze as one. Valgrind swings wide, and the souls pass out of Myrkviðr to the mead-hall of the einherjar.'
        : 'The four runes blaze as one. Freyja chooses her own — the meadow gate opens, and the souls pass out of Myrkviðr to Sessrúmnir.';
      card.innerHTML = `<div class="endgame win">
        <div class="vic-glyph">${gglyph}</div>
        <h1>${GATE_NAMES[state.winnerGate].toUpperCase()}</h1>
        <p class="vic-sub">${flavor}</p>
        <div class="vic-souls">${souls}</div>
        <p class="vic-stats">A saga of ${state.turnsTaken} turns,
        with ${state.stackCount === 0 ? 'not one tile' : state.stackCount === 1 ? 'a single tile' : state.stackCount + ' tiles'} of hope to spare.</p>
      </div>`;
    } else {
      card.innerHTML = `<div class="endgame loss">
        <div style="font-size:44px">ᛁ</div>
        <h1>THE MIST TAKES ALL</h1>
        <p>${escapeHtml(state.lossReason || 'The souls are lost.')}</p>
      </div>`;
    }
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

  // Shared joy (Wunjo): the bearer names which neighbor their Stay steels
  if (aw && aw.type === 'shared-joy' && isMine(aw.seat)) {
    card.innerHTML = `<h2>Shared joy ᚹ</h2>
      <p>Your Stay steels a neighbor’s Resolve — who takes heart?</p>`;
    const row = document.createElement('div'); row.className = 'row';
    for (const o of aw.options) {
      const b = document.createElement('button'); b.className = 'btn primary';
      b.innerHTML = `${escapeHtml(o.name)} <small>${'◆'.repeat(o.resolve)}${'◇'.repeat(Math.max(0, 2 - o.resolve))}</small>`;
      b.onclick = () => act({ seat: o.seat });
      row.appendChild(b);
    }
    card.appendChild(row);
    modal.classList.remove('hidden');
    return;
  }

  // Winter stores (Fehu): buy back the tile the cold just took
  if (aw && aw.type === 'winter-stores' && isMine(aw.seat)) {
    const what = !aw.tile ? 'a tile'
      : aw.tile.kind === 'gate' ? `the Gate of ${GATE_NAMES[aw.tile.gate]}`
        : aw.tile.kind === 'rune' ? 'a Rune Circle' : 'a path tile';
    card.innerHTML = `<h2>Freyja’s stores ᚠ</h2>
      <p>The cold has taken ${what}. Open the stores and return it to the forest?</p>`;
    const row = document.createElement('div'); row.className = 'row';
    const yes = document.createElement('button'); yes.className = 'btn primary';
    yes.innerHTML = 'Return it <small>(1 ◆)</small>';
    yes.onclick = () => act({ restore: true });
    const no = document.createElement('button'); no.className = 'btn'; no.textContent = 'Let it go';
    no.onclick = () => act({ restore: false });
    row.append(yes, no); card.appendChild(row);
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
    const oneGate = aw.gates && aw.gates.length === 1
      ? `<p class="hint">Only the Gate of ${GATE_NAMES[aw.gates[0]]} still stands — the stones choose from its runes alone.</p>` : '';
    card.innerHTML = `<h2>The Rune Circle</h2>
      <p>The stones do not ask — they <b>choose</b>. ${escapeHtml(p.name)} may accept a random
      unclaimed mark (it replaces any they bear), or leave fate untested.</p>
      ${oneGate}${held ? `<p class="hint">Marks already borne: ${held}</p>` : ''}`;
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
    const attainable = aw.gates || ['valhalla', 'folkvangr']; // older states: all
    for (const pantheon of ['valhalla', 'folkvangr']) {
      // a wholly lost gate seals its runes — show them, but greyed and dead,
      // so nobody swears a mark that can never open a way
      const lost = !attainable.includes(pantheon);
      const col = document.createElement('div'); col.className = 'rune-col ' + pantheon + (lost ? ' lost' : '');
      col.innerHTML = `<h4>${GATE_NAMES[pantheon].toUpperCase()}${lost ? '<small class="gate-lost-tag">lost to the mist</small>' : ''}</h4>`;
      RUNES[pantheon].forEach(rn => {
        const holder = aw.taken.find(t => t.p === pantheon && t.k === rn.k);
        const b = document.createElement('button');
        b.className = 'rune-btn' + (holder && holder.seat === aw.seat ? ' mine' : '');
        b.innerHTML = `<span class="glyph">${rn.g}</span><span>${rn.name}<br><small style="color:var(--dim)">${rn.gloss}</small>
          ${state.runePerks && rn.perk ? `<br><small class="perk-line">✦ ${rn.perk}</small>` : ''}</span>
          ${holder ? `<span class="taken">${escapeHtml(seatName(holder.seat))}</span>` : ''}`;
        if (lost) { b.disabled = true; b.title = 'This gate is lost — its runes hold no power now.'; }
        else b.onclick = () => act({ p: pantheon, k: rn.k });
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
    updateLobbyCTA(); // an invited visitor's primary action is Join
    $('lobby-error').textContent = 'You were invited to saga ' + code + ' — choose a name and join!';
    $('name-input').focus();
  }
} else if (lastCode && token) {
  rejoin();
}

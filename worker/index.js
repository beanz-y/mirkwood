/*
 * Mirkwood — Cloudflare Worker entry.
 *
 * Static assets are served from /public (see wrangler.jsonc). Every game room
 * is one Durable Object, addressed by its 4-letter saga code, holding the
 * authoritative engine state in DO storage so games survive disconnects and
 * hibernation. WebSockets use the hibernation API, so idle rooms cost nothing.
 */
import { createGame, applyAction, publicState, concede, renameSoul, normTiles, STATE_VERSION, PLAYER_COLORS, TOKEN_ICON_KEYS } from '../public/shared/engine.js';
import { logSaga, telemetryConfigured } from './firestore.js';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const makeCode = () =>
  Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // telemetry self-test: open /telemetry-test in a browser to verify the
    // whole chain (secrets -> token -> Firestore write). Writes one document
    // of type "test" to the sagas collection. Harmless diagnostic.
    if (url.pathname === '/telemetry-test') {
      const headers = { 'Content-Type': 'application/json' };
      // what the RUNTIME actually sees (names only — never values)
      const present = {
        FIREBASE_PROJECT_ID: !!env.FIREBASE_PROJECT_ID,
        FIREBASE_SERVICE_ACCOUNT: !!env.FIREBASE_SERVICE_ACCOUNT,
      };
      const runtimeVarNames = Object.keys(env)
        .filter(k => typeof env[k] === 'string');
      if (!telemetryConfigured(env)) {
        return new Response(JSON.stringify({
          ok: false,
          configured: false,
          present,
          runtimeVarNames,
          hints: [
            'The values must live under the WORKER runtime: Workers & Pages → mirkwood → Settings → "Variables and Secrets" — NOT under the Build configuration\'s "Build variables" (those only exist during the git build and never reach the running Worker).',
            'Use type "Secret", not "Text": plaintext vars set in the dashboard are DELETED by every git deploy unless keep_vars is set; secrets persist across deploys.',
            'After adding, confirm the dashboard\'s deploy/save prompt so a new version ships — then re-open this URL (no git push needed).',
            'Verify you are editing the exact Worker that serves this URL (Settings → Domains & Routes).',
          ],
        }, null, 2), { status: 200, headers });
      }
      try {
        await logSaga(env, { type: 'test', note: 'telemetry self-test', endedAt: new Date() });
        return new Response(JSON.stringify({
          ok: true,
          configured: true,
          wrote: 'one test document to the "sagas" collection — check the Firestore console',
        }, null, 2), { status: 200, headers });
      } catch (e) {
        return new Response(JSON.stringify({
          ok: false,
          configured: true,
          error: String(e.message || e).slice(0, 500),
          hints: [
            '403/PERMISSION_DENIED: the service account lacks Firestore access — grant it the "Cloud Datastore User" role in Google Cloud IAM (or use the Firebase console Admin SDK key)',
            '404/NOT_FOUND: no Firestore database exists yet — Firebase console → Build → Firestore Database → Create database',
            'FAILED_PRECONDITION mentioning Datastore Mode: recreate the database in NATIVE mode (the documents API requires it)',
            'invalid_grant / DECODER errors: the FIREBASE_SERVICE_ACCOUNT secret is not the complete, unmodified JSON file',
          ],
        }, null, 2), { status: 200, headers });
      }
    }
    if (url.pathname === '/ws') {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket', { status: 426 });
      }
      const isNew = url.searchParams.get('new') === '1';
      const code = isNew ? makeCode() : (url.searchParams.get('room') || '').toUpperCase().trim();
      if (!/^[A-Z]{4}$/.test(code)) return new Response('Bad room code', { status: 400 });
      url.searchParams.set('code', code);
      url.searchParams.set('init', isNew ? '1' : '0');
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(new Request(url.toString(), req));
    }
    return env.ASSETS.fetch(req);
  },
};

const IDLE_PURGE_MS = 24 * 3600 * 1000; // empty rooms are forgotten after a day

export class MirkwoodRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = undefined; // undefined = not loaded yet; null = no room here
  }

  async load() {
    if (this.room === undefined) {
      this.room = (await this.ctx.storage.get('room')) ?? null;
      // a saga persisted by an older engine cannot safely continue after a
      // deploy that changed the state shape — end it gracefully
      if (this.room && this.room.state && this.room.state.v !== STATE_VERSION) {
        this.room.state = null;
        this.room.notice = 'The forest shifted while you were away — that saga could not survive the update. Begin a new telling.';
        await this.save();
      }
    }
  }

  async save() {
    await this.ctx.storage.put('room', this.room);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_PURGE_MS);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.room = null;
    } else {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_PURGE_MS);
    }
  }

  async fetch(req) {
    await this.load();
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    if (url.searchParams.get('init') === '1') {
      if (this.room && this.ctx.getWebSockets().length > 0) {
        return new Response('Room code collision — try again', { status: 409 });
      }
      this.room = {
        code,
        host: null,
        seats: [null, null, null, null], // {token, name, color, icon}
        members: {},                     // token -> {name}
        state: null,
      };
      await this.save();
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---------------------------------------------------------------- plumbing

  tokenOf(ws) {
    const att = ws.deserializeAttachment();
    return att ? att.token : null;
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* gone */ }
  }

  roomView(token) {
    const r = this.room;
    return {
      code: r.code,
      youAreHost: r.host === token,
      started: !!r.state,
      config: r.config || null,
      seats: r.seats.map((s, i) => ({
        seat: i,
        name: s ? s.name : null,
        claimed: !!s,
        you: !!s && s.token === token,
        color: (s && s.color) || PLAYER_COLORS[i],
        icon: (s && s.icon) || TOKEN_ICON_KEYS[i],
      })),
      members: Object.values(r.members).map(m => m.name),
      // live, registered connections holding no seat — the watchers in the mist
      watchers: [...new Set(this.ctx.getWebSockets().map(w => this.tokenOf(w))
        .filter(t => t && !r.seats.some(s => s && s.token === t)))]
        .map(t => this.nameOf(t)),
    };
  }

  broadcast() {
    if (!this.room) return;
    const state = this.room.state ? publicState(this.room.state) : null;
    for (const ws of this.ctx.getWebSockets()) {
      const token = this.tokenOf(ws);
      if (!token) continue; // connected but not yet registered
      this.send(ws, { t: 'room', room: this.roomView(token) });
      if (state) this.send(ws, { t: 'state', state });
    }
  }

  nameOf(token) {
    const m = this.room && this.room.members[token];
    return (m && m.name) || 'A wanderer';
  }

  // the first color and sigil no other seat is wearing — a fresh claim never
  // collides, and the fourth player still has five of each to choose from
  seatLook(i) {
    const r = this.room;
    const used = k => new Set(r.seats.filter((s, j) => s && j !== i).map(s => s[k]).filter(Boolean));
    const uc = used('color'), ui = used('icon');
    return {
      color: PLAYER_COLORS.find(c => !uc.has(c)) || PLAYER_COLORS[i],
      icon: TOKEN_ICON_KEYS.find(k => !ui.has(k)) || TOKEN_ICON_KEYS[i],
    };
  }

  // one Firestore document per finished saga — silent no-op unless the
  // Firebase env/secret are configured (see worker/firestore.js); telemetry
  // failures must never affect gameplay
  async maybeLogEnd() {
    const r = this.room;
    const st = r && r.state;
    if (!st || (st.phase !== 'won' && st.phase !== 'lost') || st.telemetryLogged) return;
    if (!telemetryConfigured(this.env)) {
      // visible in the dashboard's Logs view so a missing config isn't silent
      console.log(`saga ${r.code} ended (${st.phase}) — telemetry not configured, skipping`);
      return;
    }
    st.telemetryLogged = true;
    await this.save();
    try {
      const cfg = r.config || {};
      const humans = new Set(r.seats.filter(Boolean).map(s => s.token)).size;
      await logSaga(this.env, {
        code: r.code,
        result: st.phase,
        winnerGate: st.winnerGate || null,
        lossReason: st.lossReason || null,
        turns: st.turnsTaken || 0,
        stackLeft: (st.stack && st.stack.length) || 0,
        niflheim: !!st.niflheim,
        difficulty: cfg.label || 'Normal',
        randomRunes: !!cfg.randomRunes,
        turnTimer: cfg.turnTimer || 0,
        humans,
        durationSec: st.startedAt ? Math.round((Date.now() - st.startedAt) / 1000) : null,
        endedAt: new Date(),
        stateVersion: st.v || 0,
      });
    } catch (e) {
      console.error('saga telemetry failed:', e.message);
    }
  }

  // ---------------------------------------------------------------- messages

  async webSocketMessage(ws, raw) {
    await this.load();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      await this.handle(ws, msg);
    } catch (e) {
      this.send(ws, { t: 'error', msg: e.illegal ? e.message : 'Something went wrong.' });
      if (!e.illegal) console.error(e);
    }
  }

  async webSocketClose(ws) {
    await this.load();
    if (this.room) {
      // before the saga starts, a vanished player's claimed souls are freed
      // (a quick refresh usually reconnects before the old socket closes,
      // so the claim survives; a genuine departure releases it)
      if (!this.room.state) {
        const live = new Set(this.ctx.getWebSockets()
          .filter(w => w !== ws)
          .map(w => this.tokenOf(w))
          .filter(Boolean));
        let changed = false;
        for (let i = 0; i < 4; i++) {
          const st = this.room.seats[i];
          if (st && !live.has(st.token)) { this.room.seats[i] = null; changed = true; }
        }
        if (changed) await this.save();
      }
      this.broadcast();
    }
    await this.ctx.storage.setAlarm(Date.now() + IDLE_PURGE_MS);
  }

  webSocketError() { /* close handler does the work */ }

  async handle(ws, msg) {
    const r = this.room;

    // registration first: 'create' and 'join' behave the same once the
    // worker has routed us here (init already provisioned a fresh room)
    if (msg.t === 'create' || msg.t === 'join') {
      if (!r) {
        this.send(ws, { t: 'error', msg: 'No such saga. Check the room code.', fatal: true });
        try { ws.close(4004, 'no room'); } catch { /* already closed */ }
        return;
      }
      const token = msg.token || crypto.randomUUID();
      const name = clean(msg.name) || 'Wanderer';
      if (!r.members[token]) r.members[token] = { name };
      else if (clean(msg.name)) r.members[token].name = name;
      if (!r.host) r.host = token; // first soul to register hosts the saga
      ws.serializeAttachment({ token });
      // orphaned lobby: if the host's token is gone for good (e.g. cleared
      // browser storage), the horn passes to whoever shows up
      if (!r.state && r.host !== token) {
        const hostLive = this.ctx.getWebSockets().some(w => this.tokenOf(w) === r.host);
        if (!hostLive) r.host = token;
      }
      await this.save();
      this.send(ws, { t: 'joined', code: r.code, token });
      if (r.notice) {
        this.send(ws, { t: 'error', msg: r.notice });
        r.notice = null;
        await this.save();
      }
      this.broadcast();
      return;
    }

    const token = this.tokenOf(ws);
    if (!r || !token) { this.send(ws, { t: 'error', msg: 'Join a saga first.' }); return; }

    switch (msg.t) {
      case 'claim': {
        const i = msg.seat | 0;
        if (i < 0 || i > 3) return;
        if (r.state) {
          // mid-game: only a vacant soul (kicked or abandoned) may be adopted —
          // it keeps the look it wears on the board but takes its new keeper's
          // name, so nobody is talking to a departed player's ghost
          if (r.seats[i]) { this.send(ws, { t: 'error', msg: 'That soul is already claimed.' }); return; }
          const soul = r.state.players[i];
          r.seats[i] = { token, name: this.nameOf(token), color: soul.color, icon: soul.icon };
          renameSoul(r.state, i, this.nameOf(token));
        } else {
          if (r.seats[i] && r.seats[i].token !== token) {
            this.send(ws, { t: 'error', msg: 'That soul is already claimed.' }); return;
          }
          r.seats[i] = r.seats[i] ? null : { token, name: this.nameOf(token), ...this.seatLook(i) };
        }
        await this.save();
        this.broadcast();
        return;
      }
      case 'kick': {
        // release a soul so another player can adopt it: the host may release
        // anyone's; any player may set free a soul of their own (e.g. to hand
        // one of several seats to a latecomer)
        const i = msg.seat | 0;
        if (i < 0 || i > 3) return;
        const seat = r.seats[i];
        if (!seat) return;
        if (seat.token !== token && r.host !== token) return;
        r.seats[i] = null;
        await this.save();
        this.broadcast();
        return;
      }
      case 'claimAll': {
        if (r.state) return;
        for (let i = 0; i < 4; i++) {
          if (!r.seats[i]) r.seats[i] = { token, name: this.nameOf(token), ...this.seatLook(i) };
        }
        await this.save();
        this.broadcast();
        return;
      }
      case 'look': {
        // a player dresses their soul: one of eight colors and eight sigils,
        // no two seats alike. Lobby (or between sagas) only.
        const i = msg.seat | 0;
        if (i < 0 || i > 3) return;
        if (r.state && r.state.phase !== 'won' && r.state.phase !== 'lost') return;
        const seat = r.seats[i];
        if (!seat || seat.token !== token) return;
        if (PLAYER_COLORS.includes(msg.color)) {
          if (r.seats.some((s, j) => s && j !== i && s.color === msg.color)) {
            this.send(ws, { t: 'error', msg: 'Another soul already wears that color.' }); return;
          }
          seat.color = msg.color;
        }
        if (TOKEN_ICON_KEYS.includes(msg.icon)) {
          if (r.seats.some((s, j) => s && j !== i && s.icon === msg.icon)) {
            this.send(ws, { t: 'error', msg: 'Another soul already bears that sigil.' }); return;
          }
          seat.icon = msg.icon;
        }
        await this.save();
        this.broadcast();
        return;
      }
      case 'start': {
        if (r.host !== token) { this.send(ws, { t: 'error', msg: 'Only the host may begin the saga.' }); return; }
        if (r.state && r.state.phase !== 'won' && r.state.phase !== 'lost') return;
        if (!r.seats.every(Boolean)) { this.send(ws, { t: 'error', msg: 'All four souls must be claimed first.' }); return; }
        const names = r.seats.map((s, i) => {
          const dup = r.seats.filter(x => x.token === s.token).length > 1;
          return dup ? `${s.name} ${['I', 'II', 'III', 'IV'][i]}` : s.name;
        });
        r.state = createGame({
          names,
          appearance: r.seats.map((s, i) => ({
            color: (s && s.color) || PLAYER_COLORS[i],
            icon: (s && s.icon) || TOKEN_ICON_KEYS[i],
          })),
          tiles: r.config || undefined,
          label: r.config ? r.config.label : '',
          randomRunes: !!(r.config && r.config.randomRunes),
        });
        await this.save();
        this.broadcast();
        return;
      }
      case 'config': {
        // host tunes the difficulty before the saga begins
        if (r.host !== token || r.state) return;
        const tiles = normTiles(msg.config || {});
        const label = ['Normal', 'Hard', 'Custom'].includes(msg.config && msg.config.label)
          ? msg.config.label : 'Custom';
        const tt = [0, 60, 90, 120, 180].includes(+(msg.config && msg.config.turnTimer))
          ? +msg.config.turnTimer : 0;
        r.config = {
          ...tiles, label,
          randomRunes: msg.config && msg.config.randomRunes ? 1 : 0,
          turnTimer: tt,
        };
        await this.save();
        this.broadcast();
        return;
      }
      case 'ping': {
        // a transient "look here" marker on a board cell, relayed to everyone
        // (including the sender, for feedback). Ephemeral: no state, no save.
        if (!r.state) return;
        const now = Date.now();
        this.pingAt = this.pingAt || {};
        if (now - (this.pingAt[token] || 0) < 250) return; // light anti-spam throttle
        this.pingAt[token] = now;
        const pr = msg.r | 0, pc = msg.c | 0;
        if (pr < 0 || pr > 5 || pc < 0 || pc > 5) return;
        let color = '#d9d3c0', seat = r.seats.findIndex(s => s && s.token === token);
        if (seat >= 0) color = (r.state.players[seat] && r.state.players[seat].color) || color;
        const relay = { t: 'ping', r: pr, c: pc, name: this.nameOf(token), color };
        for (const w of this.ctx.getWebSockets()) this.send(w, relay);
        return;
      }
      case 'preview': {
        // the active player's pending tile placement (cell + rotation), relayed
        // live to everyone else so out-of-turn players and watchers can follow
        // along. Ephemeral: never touches game state and is never persisted.
        if (!r.state) return;
        const aw = r.state.awaiting;
        if (!aw) return;
        const owner = r.seats[aw.seat];
        if (!owner || owner.token !== token) return; // only the soul on the clock
        const relay = { t: 'preview', seat: aw.seat, r: msg.r, c: msg.c, rot: msg.rot | 0 };
        for (const w of this.ctx.getWebSockets()) {
          if (w !== ws) this.send(w, relay);
        }
        return;
      }
      case 'act': {
        if (!r.state) return;
        const aw = r.state.awaiting;
        if (!aw) { this.send(ws, { t: 'error', msg: 'Nothing is awaited.' }); return; }
        const owner = r.seats[aw.seat];
        if (!owner || owner.token !== token) {
          this.send(ws, { t: 'error', msg: 'That decision belongs to another soul.' }); return;
        }
        applyAction(r.state, aw.seat, msg.payload || {});
        await this.save();
        this.broadcast();
        await this.maybeLogEnd();
        return;
      }
      case 'concede': {
        if (!r.state || r.host !== token) return;
        if (r.state.phase === 'won' || r.state.phase === 'lost') return;
        concede(r.state);
        await this.save();
        this.broadcast();
        await this.maybeLogEnd();
        return;
      }
      case 'restart': {
        if (r.host !== token) return;
        if (r.state && r.state.phase !== 'won' && r.state.phase !== 'lost') return;
        r.state = null;
        // free the souls of anyone who wandered off during the last saga
        const live = new Set(this.ctx.getWebSockets().map(w => this.tokenOf(w)).filter(Boolean));
        for (let i = 0; i < 4; i++) {
          if (r.seats[i] && !live.has(r.seats[i].token)) r.seats[i] = null;
        }
        await this.save();
        this.broadcast();
        return;
      }
      case 'chat':
        // Whispers removed 2026-07-09: no user-to-user message content is
        // relayed or stored, by design (it never was persisted — sendChat only
        // fanned out to live sockets). Silently ignored so a stale cached
        // client gets no error.
        return;
      case 'leave': {
        // before the saga starts, walking away frees the claimed souls;
        // mid-game the seats stay bound to the token so they can rejoin
        if (!r.state) {
          for (let i = 0; i < 4; i++) {
            if (r.seats[i] && r.seats[i].token === token) r.seats[i] = null;
          }
        }
        // hand the host's horn to someone still present
        if (r.host === token) {
          const heir = this.ctx.getWebSockets()
            .map(w => this.tokenOf(w))
            .find(t => t && t !== token);
          if (heir) r.host = heir;
        }
        ws.serializeAttachment(null);
        await this.save();
        try { ws.close(4001, 'left'); } catch { /* already gone */ }
        this.broadcast();
        return;
      }
    }
  }
}

function clean(s, max = 24) {
  if (typeof s !== 'string') return '';
  return s.replace(/[<>&]/g, '').trim().slice(0, max);
}

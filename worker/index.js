/*
 * Mirkwood — Cloudflare Worker entry.
 *
 * Static assets are served from /public (see wrangler.jsonc). Every game room
 * is one Durable Object, addressed by its 4-letter saga code, holding the
 * authoritative engine state in DO storage so games survive disconnects and
 * hibernation. WebSockets use the hibernation API, so idle rooms cost nothing.
 */
import { createGame, applyAction, publicState, concede } from '../public/shared/engine.js';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const makeCode = () =>
  Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
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
        seats: [null, null, null, null], // {token, name}
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
      seats: r.seats.map((s, i) => ({
        seat: i,
        name: s ? s.name : null,
        claimed: !!s,
        you: !!s && s.token === token,
      })),
      members: Object.values(r.members).map(m => m.name),
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

  sendChat(from, text) {
    const msg = { t: 'chat', from, text, at: Date.now() };
    for (const ws of this.ctx.getWebSockets()) this.send(ws, msg);
  }

  nameOf(token) {
    const m = this.room && this.room.members[token];
    return (m && m.name) || 'A wanderer';
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
      await this.save();
      this.send(ws, { t: 'joined', code: r.code, token });
      this.broadcast();
      return;
    }

    const token = this.tokenOf(ws);
    if (!r || !token) { this.send(ws, { t: 'error', msg: 'Join a saga first.' }); return; }

    switch (msg.t) {
      case 'claim': {
        const i = msg.seat | 0;
        if (i < 0 || i > 3) return;
        if (r.state) { this.send(ws, { t: 'error', msg: 'The saga has already begun.' }); return; }
        if (r.seats[i] && r.seats[i].token !== token) {
          this.send(ws, { t: 'error', msg: 'That soul is already claimed.' }); return;
        }
        r.seats[i] = r.seats[i] ? null : { token, name: this.nameOf(token) };
        await this.save();
        this.broadcast();
        return;
      }
      case 'claimAll': {
        if (r.state) return;
        for (let i = 0; i < 4; i++) {
          if (!r.seats[i]) r.seats[i] = { token, name: this.nameOf(token) };
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
        r.state = createGame({ names });
        await this.save();
        this.broadcast();
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
        return;
      }
      case 'concede': {
        if (!r.state || r.host !== token) return;
        if (r.state.phase === 'won' || r.state.phase === 'lost') return;
        concede(r.state);
        await this.save();
        this.broadcast();
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
      case 'chat': {
        const text = clean(msg.text, 300);
        if (text) this.sendChat(this.nameOf(token), text);
        return;
      }
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

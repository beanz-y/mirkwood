/*
 * Mirkwood — Cloudflare Worker entry.
 *
 * Static assets are served from /public (see wrangler.jsonc). Every game room
 * is one Durable Object, addressed by its 4-letter saga code, holding the
 * authoritative engine state in DO storage so games survive disconnects and
 * hibernation. WebSockets use the hibernation API, so idle rooms cost nothing.
 */
import { createGame, applyAction, publicState, concede, renameSoul, setLendConsent, normTiles, awaitingText, STATE_VERSION, PLAYER_COLORS, TOKEN_ICON_KEYS } from '../public/shared/engine.js';
import { logSaga, telemetryConfigured } from './firestore.js';
import { sendPush, pushConfigured, vapidPublicKey } from './push.js';

// how many sagas the switcher may ask about at once (one subrequest each)
const MAX_PEEK = 12;

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
    // the application-server key the browser must subscribe with, derived from
    // the VAPID secret so it can never drift out of sync with it. Answers with
    // null until the secret is set, which is the client's cue to stay on local
    // notifications only.
    if (url.pathname === '/push-key') {
      let key = null;
      try { key = pushConfigured(env) ? vapidPublicKey(env) : null; } catch { key = null; }
      return new Response(JSON.stringify({ key }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    // push self-test, the sibling of /telemetry-test: what does the RUNTIME
    // actually see? (names only, never values)
    if (url.pathname === '/push-test') {
      const headers = { 'Content-Type': 'application/json' };
      const present = { VAPID_JWK: !!env.VAPID_JWK, VAPID_SUBJECT: !!env.VAPID_SUBJECT };
      if (!pushConfigured(env)) {
        return new Response(JSON.stringify({
          ok: false,
          configured: false,
          present,
          effect: 'Closed-app push is OFF. The topbar bell still works while the app is backgrounded.',
          hints: [
            'Generate the key: node tools/vapid-keys.mjs — it prints one JSON line.',
            'Paste it under the WORKER runtime: Workers & Pages → mirkwood → Settings → "Variables and Secrets", name VAPID_JWK, type "Secret". NOT the Build configuration\'s build variables (those never reach the running Worker).',
            'Confirm the dashboard\'s deploy prompt so a new version ships, then reload this URL (no git push needed).',
          ],
        }, null, 2), { status: 200, headers });
      }
      try {
        const key = vapidPublicKey(env);
        return new Response(JSON.stringify({
          ok: true,
          configured: true,
          present,
          publicKey: key,
          note: 'The secret parses and the public key derives from it. Players who enable the bell will now be subscribed for closed-app pushes; delivery itself can only be confirmed on a real device (an installed app on iOS).',
        }, null, 2), { status: 200, headers });
      } catch (e) {
        return new Response(JSON.stringify({
          ok: false,
          configured: true,
          present,
          error: String(e.message || e).slice(0, 300),
          hints: [
            'The secret must be the complete JSON line printed by tools/vapid-keys.mjs (a P-256 private JWK: kty EC, crv P-256, with d/x/y).',
            'Re-run the generator and paste the whole line, with no surrounding quotes or line breaks.',
          ],
        }, null, 2), { status: 200, headers });
      }
    }
    /*
     * A glance at several sagas at once, for the saga switcher: which of them
     * are waiting on you?
     *
     * POST, with the token in the BODY on purpose — it is effectively this
     * player's credential (a join with it takes their seats), and query
     * strings end up in logs and referrers.
     *
     * Returns the raw `awaiting` fields rather than a finished sentence: the
     * client renders them through the same awaitingText() the bell and the
     * push use, so all three word a decision identically.
     */
    if (url.pathname === '/sagas' && req.method === 'POST') {
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      let body;
      try { body = await req.json(); } catch { body = null; }
      const token = body && typeof body.token === 'string' ? body.token : '';
      const codes = (body && Array.isArray(body.codes) ? body.codes : [])
        .map(c => String(c).toUpperCase().trim())
        .filter(c => /^[A-Z]{4}$/.test(c));
      const seen = [...new Set(codes)];
      if (!token || !seen.length) {
        return new Response(JSON.stringify({ ok: false, error: 'Send {token, codes:[CODE,...]}.' }),
          { status: 400, headers });
      }
      // one subrequest per saga, so keep the fan-out bounded
      if (seen.length > MAX_PEEK) {
        return new Response(JSON.stringify({ ok: false, error: `At most ${MAX_PEEK} sagas at a time.` }),
          { status: 400, headers });
      }
      const sagas = await Promise.all(seen.map(async (code) => {
        try {
          const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
          const res = await stub.fetch(new Request(`https://room/saga-peek?code=${code}`, {
            method: 'POST',
            body: JSON.stringify({ token }),
          }));
          return await res.json();
        } catch {
          // one unreachable room must not blank the whole switcher
          return { code, exists: false, error: true };
        }
      }));
      return new Response(JSON.stringify({ ok: true, sagas }, null, 2), { headers });
    }
    // Why a push did or did not ring, for one saga: /push-status?room=CODE
    // Console logging is a poor answer here — Mirkwood does everything inside
    // WebSocket handlers, and those logs are held back from the dashboard's
    // live view until the socket closes. This reads the room's own state, so
    // it is true the moment you load it, from the phone under test.
    if (url.pathname === '/push-status') {
      const code = (url.searchParams.get('room') || '').toUpperCase().trim();
      if (!/^[A-Z]{4}$/.test(code)) {
        return new Response(JSON.stringify({
          ok: false,
          error: 'Name the saga: /push-status?room=CODE (the 4-letter code).',
        }, null, 2), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(new Request(url.toString(), req));
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
        this.room.notice = 'The forest shifted while you were away. That saga could not survive the update, so begin a new telling.';
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

  /*
   * The push diagnostic for one saga. Deliberately answers the question a
   * player actually has ("why didn't my phone ring?") rather than dumping
   * state: for each soul, is its keeper connected (so their own browser would
   * ring it), and does that keeper have a device subscribed at all? Those two
   * plus lastPush explain every outcome.
   *
   * Never exposes a subscription's endpoint or keys — counts only.
   */
  pushStatus() {
    const r = this.room;
    if (!r) {
      return { ok: false, saga: null, note: 'No such saga. Check the code, or it may have been purged after a day idle.' };
    }
    const subs = r.subs || {};
    const live = new Set(this.ctx.getWebSockets().map(w => this.tokenOf(w)).filter(Boolean));
    const st = r.state;
    const aw = st && st.awaiting;
    return {
      ok: true,
      saga: r.code,
      pushConfigured: pushConfigured(this.env), // false = VAPID_JWK secret not set
      phase: st ? st.phase : 'lobby',
      awaiting: aw ? { type: aw.type, seat: aw.seat, soul: st.players[aw.seat].name } : null,
      souls: r.seats.map((s, i) => ({
        seat: i,
        name: s ? s.name : null,
        // connected but NOT watching = the app is backgrounded (its page is
        // frozen and cannot ring itself), so we push. Reporting both is the
        // point: "connected" alone was the assumption that hid this bug.
        connected: !!s && live.has(s.token),
        watching: !!s && this.watching(s.token),
        // 0 = this player never enabled the bell (on any device) in this saga
        subscribedDevices: s ? ((subs[s.token] || []).length) : 0,
      })),
      lastPush: r.lastPush || null,
      note: 'A push is sent only when the awaiting soul\'s keeper is not WATCHING (closed, or backgrounded so their page is frozen) AND has a subscribed device. If lastPush is null, none was ever attempted in this saga.',
    };
  }

  /*
   * One line of the saga switcher: does this saga need this player right now?
   *
   * Deliberately thin. It answers only what a player asked for at a glance
   * (whose move it is, and whether that is them) plus enough to name the saga.
   * Progress, souls and setup all sit in this same state if they are ever
   * wanted on the card.
   *
   * Never returns a token: `yourSeats` is computed here so the caller's own
   * token is the only one that ever leaves the browser.
   */
  sagaPeek(token, code) {
    const r = this.room;
    if (!r) return { code, exists: false }; // never begun, or purged after a day idle
    const st = r.state;
    const aw = st && st.awaiting;
    const yourSeats = r.seats
      .map((s, i) => (s && s.token === token ? i : -1))
      .filter(i => i >= 0);
    return {
      code: r.code,
      exists: true,
      started: !!st,
      phase: st ? st.phase : 'lobby',
      awaiting: aw ? { type: aw.type, seat: aw.seat, soul: st.players[aw.seat].name } : null,
      yourTurn: !!(aw && r.seats[aw.seat] && r.seats[aw.seat].token === token),
      yourSeats,
      seatsClaimed: r.seats.filter(Boolean).length,
      winnerGate: (st && st.winnerGate) || null,
    };
  }

  async fetch(req) {
    await this.load();
    const url = new URL(req.url);
    if (url.pathname === '/saga-peek') {
      let body;
      try { body = await req.json(); } catch { body = {}; }
      const code = url.searchParams.get('code');
      return new Response(JSON.stringify(this.sagaPeek(body && body.token, code)), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/push-status') {
      return new Response(JSON.stringify(this.pushStatus(), null, 2), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    const code = url.searchParams.get('code');
    if (url.searchParams.get('init') === '1') {
      if (this.room && this.ctx.getWebSockets().length > 0) {
        return new Response('Room code collision, try again', { status: 409 });
      }
      this.room = {
        code,
        host: null,
        seats: [null, null, null, null], // {token, name, color, icon}
        members: {},                     // token -> {name}
        subs: {},                        // token -> [push subscription] (see maybePush)
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

  // Merge into a socket's attachment. Never write it bare: a plain
  // serializeAttachment({away}) would drop the token, and that failure is
  // silent and severe (tokenOf -> null, so broadcast skips the socket and
  // every later message is rejected with "Join a saga first").
  attach(ws, patch) {
    const att = ws.deserializeAttachment() || {};
    ws.serializeAttachment({ ...att, ...patch });
  }

  // Has this page told us it went to the background? Attachments survive DO
  // hibernation, so the flag rides along with the token — unlike in-memory
  // state, which would report every hibernated player as watching.
  awayOf(ws) {
    const att = ws.deserializeAttachment();
    return !!(att && att.away);
  }

  // Anyone actually looking at this saga on that player's behalf? A frozen
  // background page still holds its socket, so being connected is not enough.
  // `ignore` excludes a socket that is closing: getWebSockets() still returns
  // it, so without this a dying socket would veto its own player's push.
  watching(token, ignore) {
    return this.ctx.getWebSockets()
      .some(w => w !== ignore && this.tokenOf(w) === token && !this.awayOf(w));
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
      // Will WE ring this player? The client's own bell stands down when this
      // is true, so it must be the SAME expression maybePush() gates on, from
      // the same room — a client guessing for itself drifts (a failed send, a
      // sub we dropped as expired, or another saga's subscription) and drifts
      // in both directions: a silent miss, or a double buzz. broadcast() sends
      // 'room' before 'state' on the same ordered socket, so this is never
      // staler than the decision it is judged against.
      pushArmed: pushConfigured(this.env) && !!(((r.subs && r.subs[token]) || []).length),
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
      // the tile mix actually played: the host's config when one was set,
      // otherwise the engine's own defaults (an untouched lobby = Normal)
      const tileKeys = ['straight', 'tee', 'teeFractured', 'cross', 'rune', 'draugr', 'gateValhalla', 'gateFolkvangr'];
      const tileSrc = cfg.straight !== undefined ? cfg : normTiles({});
      const tiles = {};
      for (const k of tileKeys) tiles[k] = tileSrc[k] | 0;
      const gateExits = st.gateExits || 'one';
      const runePerks = !!st.runePerks;
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
        // customizations, so wins can be read in context (state = authoritative)
        runePerks,
        gateExits,
        uruzAdjacent: !!st.uruzAdjacent,
        tiles,
        // one query-friendly flag: did this saga deviate from plain Normal rules?
        customized: runePerks || !!cfg.randomRunes || gateExits !== 'one' || (cfg.label || 'Normal') === 'Custom',
        // winter-form usage (perks games): was the refusal spoken / stores opened?
        perkUse: runePerks && st.perkUse
          ? { refusal: !!st.perkUse.refusal, stores: st.perkUse.stores | 0 } : null,
        // the marks borne at the end, anonymously — which runes carried the day
        finalRunes: st.players ? st.players.filter(p => p.rune).map(p => `${p.rune.p}:${p.rune.k}`) : null,
        humans,
        durationSec: st.startedAt ? Math.round((Date.now() - st.startedAt) / 1000) : null,
        endedAt: new Date(),
        stateVersion: st.v || 0,
      });
    } catch (e) {
      console.error('saga telemetry failed:', e.message);
    }
  }

  /*
   * Ring a player who cannot ring themselves.
   *
   * The question is NOT "is their socket still here?" — that was the original
   * mistake. The page's own bell needs its JS to be RUNNING, and a socket
   * being open says nothing about that. When a phone backgrounds an installed
   * app the browser freezes the page (suspending even network event handlers)
   * but leaves the WebSocket open — Chrome's freeze guidance tells authors to
   * close their own sockets, which is proof the browser will not. On iOS that
   * freeze lands within about five seconds. So a backgrounded player looked
   * "connected" to us while their page was incapable of notifying them, and
   * both tiers stayed quiet.
   *
   * So the real question is "is anyone WATCHING?": a socket counts only while
   * its page has told us it is visible (see the 'away' message). Closed app,
   * backgrounded app and frozen app all collapse into the same answer: no.
   *
   * Silent no-op unless the VAPID secret is set (see worker/push.js), and
   * never allowed to disturb a saga: the sends happen after the broadcast, off
   * the critical path, and failures are swallowed.
   */
  async maybePush(ignore) {
    const r = this.room;
    const st = r && r.state;
    if (!st || !pushConfigured(this.env)) return;
    if (st.phase !== 'play' && st.phase !== 'setup') return;
    const aw = st.awaiting;
    if (!aw) return;
    const seat = r.seats[aw.seat];
    if (!seat) return; // a vacant soul: no one to ring (adoption covers it)
    // watching = connected AND the page says it is on screen. A backgrounded
    // page is frozen, so its bell cannot fire and this push is the only way.
    if (this.watching(seat.token, ignore)) return;
    const subs = (r.subs && r.subs[seat.token]) || [];
    if (!subs.length) return; // never enabled the bell, or not on this device
    const sig = `${aw.type}:${aw.seat}:${st.seq || 0}`;
    if (r.pushSig === sig) return; // one ping per decision
    r.pushSig = sig;
    await this.save();

    const payload = {
      title: 'Mirkwood',
      body: awaitingText(aw.type, st.players[aw.seat].name),
      tag: 'mk-turn',
      url: `/?room=${r.code}`, // reopens straight into the saga, not the lobby
    };
    this.ctx.waitUntil((async () => {
      const results = await Promise.all(subs.map(s => sendPush(this.env, s, payload)));
      // a browser that has thrown its subscription away (uninstalled, blocked,
      // expired) tells us so once — forget it rather than push into the void
      const keep = subs.filter((s, i) => !results[i].gone);
      const accepted = results.filter(x => x.ok).length;
      const failed = results.filter(x => !x.ok && !x.gone);

      // Trace either way. Logging only failures makes silence ambiguous
      // between "never tried" and "worked". NB console.log inside a WebSocket
      // handler is buffered out of the dashboard's LIVE view until the socket
      // closes, so /push-status below is the reliable read, not this line.
      console.log(`push to seat ${aw.seat} (${st.players[aw.seat].name}): `
        + `${accepted}/${results.length} accepted by the push service`
        + `${failed.length ? `, first failure ${JSON.stringify(failed[0])}` : ''}`
        + `${results.length !== keep.length ? `, dropped ${results.length - keep.length} expired` : ''}`);

      await this.load();
      if (!this.room) return;
      // what /push-status reports: enough to tell a push that was never
      // attempted from one the push service accepted
      this.room.lastPush = {
        at: new Date().toISOString(),
        seat: aw.seat,
        soul: st.players[aw.seat].name,
        said: payload.body,
        accepted,
        devices: results.length,
        expiredDropped: results.length - keep.length,
        failure: failed.length
          ? (failed[0].status ? `HTTP ${failed[0].status}` : failed[0].error) : null,
      };
      if (this.room.subs && this.room.subs[seat.token] && keep.length !== subs.length) {
        const alive = new Set(keep.map(s => s.endpoint));
        this.room.subs[seat.token] = this.room.subs[seat.token].filter(s => alive.has(s.endpoint));
        if (!this.room.subs[seat.token].length) delete this.room.subs[seat.token];
        // we just stopped being able to ring them: say so, or their own bell
        // stays stood down for a Worker that can no longer reach them
        this.broadcast();
      }
      await this.save();
    })());
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
      /*
       * Ask again now that this socket is gone.
       *
       * This is the safety net under the 'away' message, which is sent from
       * the least reliable moment there is: a page can be frozen or discarded
       * before it flushes, leaving a zombie socket that looks like someone
       * watching. A zombie is only a zombie until the edge reaps it, and this
       * is that moment. maybePush writes its dedupe signature only AFTER its
       * early returns, so a decision suppressed by the zombie is still
       * eligible and rings exactly once, late rather than never.
       *
       * getWebSockets() still returns this closing socket, so it must be
       * excluded or it would veto its own player's push.
       */
      await this.maybePush(ws);
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
      // A page that rejoins while already hidden must say so in the same
      // breath as its token: the socket is new, but the phone is still in a
      // pocket. Carrying it here (rather than in a later message) makes it
      // atomic with registration, so it cannot be lost to a freeze.
      ws.serializeAttachment({ token, away: msg.away === true });
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
          gateExits: (r.config && r.config.gateExits) || 'one',
          runePerks: !!(r.config && r.config.runePerks),
          // Dan's rule: on a Hard telling, Uruz lends to neighbors only
          uruzAdjacent: !!(r.config && r.config.label === 'Hard'),
        });
        await this.save();
        this.broadcast();
        await this.maybePush(); // the first soul to awaken may already be away
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
          runePerks: msg.config && msg.config.runePerks ? 1 : 0,
          gateExits: ['one', 'straight', 'tee'].includes(msg.config && msg.config.gateExits)
            ? msg.config.gateExits : 'one',
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
      case 'lend': {
        // Deep vitality consent (rune perks): the seat's owner opens or closes
        // their purse. Standing toggle — valid any time mid-saga.
        if (!r.state || !r.state.runePerks) return;
        const i = msg.seat | 0;
        if (i < 0 || i > 3) return;
        const seat = r.seats[i];
        if (!seat || seat.token !== token) return;
        setLendConsent(r.state, i, !!msg.on);
        await this.save();
        this.broadcast();
        return;
      }
      case 'away': {
        /*
         * "My page is going to sleep" / "I am back". Sent from the client's
         * visibilitychange handler, the last moment a backgrounding page is
         * guaranteed to still be running. This is what tells a frozen page
         * from a watching one: the socket looks identical either way.
         *
         * No save(): an attachment is not room storage, so app-switching all
         * evening costs no storage writes.
         */
        this.attach(ws, { away: !!msg.away });
        // Going away re-opens the question. Nothing else would ever ask it
        // again: only the awaiting player can act, so a decision that landed
        // while they were watching would hang forever, silently, if they then
        // pocketed the phone. And visibilitychange also fires on a screen
        // lock or an incoming call, where they never registered whose turn it
        // was. The push is the durable trace that the saga wants them.
        if (msg.away) await this.maybePush();
        return;
      }
      case 'push-sub': {
        // this browser's subscription for closed-app notifications. Held per
        // token rather than per seat (one player may keep several souls, and
        // may play from a phone and a laptop), and forgotten when the room is
        // purged — nothing here outlives the saga by more than a day.
        const sub = msg.sub;
        if (!sub || typeof sub.endpoint !== 'string'
          || typeof sub.p256dh !== 'string' || typeof sub.auth !== 'string') return;
        if (!sub.endpoint.startsWith('https://') || sub.endpoint.length > 600) return;
        r.subs = r.subs || {};
        const list = (r.subs[token] || []).filter(s => s.endpoint !== sub.endpoint);
        list.push({
          endpoint: sub.endpoint,
          p256dh: sub.p256dh.slice(0, 200),
          auth: sub.auth.slice(0, 60),
        });
        r.subs[token] = list.slice(-3); // a player's last few devices
        await this.save();
        this.broadcast(); // roomView.pushArmed just changed: their bell stands down
        return;
      }
      case 'push-unsub': {
        // the bell was switched off: forget this device immediately rather
        // than waiting for the room to purge
        if (!r.subs || !r.subs[token]) return;
        r.subs[token] = r.subs[token].filter(s => s.endpoint !== msg.endpoint);
        if (!r.subs[token].length) delete r.subs[token];
        await this.save();
        this.broadcast(); // pushArmed is false again: their own bell resumes
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
        await this.maybePush(); // the next soul may not be here to see it
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
        // walking away is deliberate, so stop ringing this player at once
        // rather than holding their subscription until the room purges
        if (r.subs) delete r.subs[token];
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

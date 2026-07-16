/*
 * Web Push for Mirkwood — the tier that reaches a CLOSED installed app.
 *
 * The topbar bell's local notifications (public/client.js) only reach a
 * backgrounded tab: they are fired by the page itself, so a closed app is
 * silent. A real push is delivered by the browser's push service instead, so
 * the app need not be running at all.
 *
 * Two specs are in play here, and both are implemented below:
 *   - RFC 8291: the payload is encrypted end-to-end (aes128gcm) with keys only
 *     the subscribing browser holds. The push service relays ciphertext it
 *     cannot read.
 *   - RFC 8292 (VAPID): each request is signed with our private key so the
 *     push service can tell who is sending, and only we can push to our subs.
 *
 * Entirely optional, exactly like worker/firestore.js: every entry point is a
 * silent no-op unless VAPID_JWK is configured, so the repo carries no key
 * material and push simply stays off until the secret is set.
 *
 * Configure ONE secret (dashboard → Settings → Variables and Secrets, type
 * Secret — never Build variables, see the README):
 *   VAPID_JWK   the private JWK printed by `node tools/vapid-keys.mjs`
 * The public application-server key is DERIVED from that JWK's x/y, so the
 * client's key can never drift out of sync with the signing key.
 * Optional: VAPID_SUBJECT (contact URL the push service may use; defaults to
 * the address already published in the privacy notice).
 *
 * Verify the whole chain at /push-test. Crypto is checked offline against the
 * RFC 8291 §5 worked example in test/push.test.js.
 */

const DEFAULT_SUBJECT = 'mailto:mirkwood@beanz-y.com';

// How long the push service keeps trying if the device is offline. A saga
// waits for its player, so a ping that lands hours later is still useful —
// but not past the room's own 24h idle purge.
const PUSH_TTL = 6 * 3600;

// RFC 8188 record size. Our payloads are a few hundred bytes; one record.
const RECORD_SIZE = 4096;

const TE = s => new TextEncoder().encode(s);

function b64urlEncode(input) {
  const bytes = new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// HKDF (RFC 5869). Web Push chains two of these: once to mix the subscription's
// auth secret into the ECDH secret, then once per derived value (key, nonce).
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8,
  );
  return new Uint8Array(bits);
}

// A pasted secret may carry fields (use, key_ops, alg) that make importKey
// reject it for signing, so rebuild the JWK from just the parts that matter.
function parseJwk(env) {
  const jwk = JSON.parse(env.VAPID_JWK);
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) {
    throw new Error('VAPID_JWK is not a P-256 private JWK (expected kty EC, crv P-256, with d/x/y)');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true };
}

export function pushConfigured(env) {
  return !!(env && env.VAPID_JWK);
}

// The applicationServerKey the browser must subscribe with: the uncompressed
// P-256 point (0x04 || x || y) rebuilt from the private JWK it is signed by.
export function vapidPublicKey(env) {
  const jwk = parseJwk(env);
  return b64urlEncode(concat(new Uint8Array([4]), b64urlDecode(jwk.x), b64urlDecode(jwk.y)));
}

/*
 * RFC 8291 §3.4 + RFC 8188. Returns the complete request body:
 *   salt(16) || rs(4) || idlen(1) || as_public(65) || aes128gcm ciphertext
 *
 * `opts.salt` and `opts.asKeys` exist so the test can pin the RFC's fixed
 * values and compare against its published body; production passes neither and
 * gets a fresh random salt and ephemeral keypair per message (required: the
 * key/nonce must never repeat).
 */
export async function encryptPayload(plaintext, p256dh, auth, opts = {}) {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const asKeys = opts.asKeys || await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, asKeys.privateKey, 256,
  ));

  // the auth secret is the salt here, binding the keys to this subscription
  const keyInfo = concat(TE('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, concat(TE('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(TE('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 delimits the last (only) record; 0x01 would mean more follow
  const padded = concat(TE(plaintext), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, padded,
  ));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length; // 65
  return concat(header, asPublic, ciphertext);
}

/*
 * RFC 8292: a short-lived ES256 JWT scoped to the push service's origin, plus
 * our public key, so the service can authenticate the sender. WebCrypto's
 * ECDSA signature is already the raw r||s that JWS wants.
 */
export async function vapidAuth(env, endpoint, now = Date.now()) {
  const jwk = parseJwk(env);
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const header = b64urlEncode(TE(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(TE(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600, // spec caps this at 24h
    sub: env.VAPID_SUBJECT || DEFAULT_SUBJECT,
  })));
  const unsigned = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, TE(unsigned));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${vapidPublicKey(env)}`;
}

/*
 * Deliver one notification. Never throws: a push failing must not disturb a
 * saga. `gone` marks a subscription the browser has discarded (uninstalled,
 * permission revoked, expired) so the caller can forget it.
 */
export async function sendPush(env, sub, payload, opts = {}) {
  if (!pushConfigured(env)) return { ok: false, skipped: true };
  try {
    const body = await encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth, opts);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuth(env, sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(opts.ttl ?? PUSH_TTL),
        Urgency: 'high', // a soul is waiting on this decision
      },
      body,
    });
    return {
      ok: res.ok,
      status: res.status,
      // 404/410: the subscription no longer exists and never will again
      gone: res.status === 404 || res.status === 410,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

/*
 * Web Push crypto tests — run: node test/push.test.js
 *
 * The preview pane cannot grant push permission and no push service will
 * accept a made-up subscription, so the closed-app tier can't be driven
 * end-to-end from here. What CAN be proved offline is the part that would
 * fail silently on a real device (a browser simply drops a payload it cannot
 * decrypt, with no error anywhere we can see): the encryption itself.
 *
 * So we pin RFC 8291's own worked example. Given the RFC's fixed keys and
 * salt, encryptPayload must reproduce its published message body byte for
 * byte. If that passes, a real browser can decrypt what we send.
 */
import { readFileSync } from 'node:fs';
import {
  encryptPayload, vapidAuth, vapidPublicKey, pushConfigured, sendPush,
} from '../worker/push.js';
import { awaitingText } from '../public/shared/engine.js';

let passed = 0, failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('  FAIL ' + name); }
}
function section(name) { console.log('\n== ' + name); }

const b64urlDecode = (str) => {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64'));
};
const b64urlEncode = (bytes) => Buffer.from(bytes).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------------------------------------------------------------------------
section('RFC 8291 §5 — push message encryption example');

// Values transcribed verbatim from the RFC's example.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  // the complete body, as printed in the RFC (line breaks joined)
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
      + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
      + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// rebuild the RFC's application-server keypair from its raw scalar + point
const asPoint = b64urlDecode(RFC.asPublic);
const asJwk = {
  kty: 'EC', crv: 'P-256',
  x: b64urlEncode(asPoint.slice(1, 33)),
  y: b64urlEncode(asPoint.slice(33, 65)),
  d: RFC.asPrivate,
};
const asKeys = {
  privateKey: await crypto.subtle.importKey(
    'jwk', asJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ),
  publicKey: await crypto.subtle.importKey(
    'raw', asPoint, { name: 'ECDH', namedCurve: 'P-256' }, true, [],
  ),
};

const body = await encryptPayload(RFC.plaintext, RFC.uaPublic, RFC.auth, {
  salt: b64urlDecode(RFC.salt),
  asKeys,
});

check(b64urlEncode(body) === RFC.body,
  'encrypted body matches the RFC 8291 example byte for byte');

// structure, so a mismatch above is diagnosable rather than just "different"
check(body.length === 144, 'body length: 16 salt + 4 rs + 1 idlen + 65 key + 58 ciphertext');
check(b64urlEncode(body.slice(0, 16)) === RFC.salt, 'body starts with the salt');
check(new DataView(body.buffer, body.byteOffset).getUint32(16) === 4096, 'record size is 4096');
check(body[20] === 65, 'key id length is 65');
check(b64urlEncode(body.slice(21, 86)) === RFC.asPublic, 'body carries the server public key');

// ---------------------------------------------------------------------------
section('the browser can decrypt what we send (fresh random salt + keypair)');

// Production path: no fixed salt or keypair. Decrypt it back with the RFC's
// user-agent private key, the way a real browser would.
const uaJwkPoint = b64urlDecode(RFC.uaPublic);
const uaPrivate = await crypto.subtle.importKey('jwk', {
  kty: 'EC', crv: 'P-256',
  x: b64urlEncode(uaJwkPoint.slice(1, 33)),
  y: b64urlEncode(uaJwkPoint.slice(33, 65)),
  d: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', // RFC's ua_private
}, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

async function browserDecrypt(msg, authSecret, uaPrivKey, uaPubRaw) {
  const salt = msg.slice(0, 16);
  const asPub = msg.slice(21, 21 + msg[20]);
  const ciphertext = msg.slice(21 + msg[20]);
  const asKey = await crypto.subtle.importKey(
    'raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: asKey }, uaPrivKey, 256,
  ));
  const hkdf = async (s, ikm, info, len) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: s, info }, k, len * 8,
    ));
  };
  const cat = (...a) => {
    const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
    let at = 0; for (const x of a) { o.set(x, at); at += x.length; }
    return o;
  };
  const TE = s => new TextEncoder().encode(s);
  const keyInfo = cat(TE('WebPush: info'), new Uint8Array([0]), uaPubRaw, asPub);
  const ikm = await hkdf(b64urlDecode(authSecret), shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, cat(TE('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, cat(TE('Content-Encoding: nonce'), new Uint8Array([0])), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce }, aes, ciphertext,
  ));
  return new TextDecoder().decode(plain.slice(0, -1)); // strip the 0x02 delimiter
}

const live = await encryptPayload(
  JSON.stringify({ title: 'Mirkwood', body: 'Bjorn: your move' }),
  RFC.uaPublic, RFC.auth,
);
const round = await browserDecrypt(live, RFC.auth, uaPrivate, uaJwkPoint);
check(JSON.parse(round).body === 'Bjorn: your move', 'a real notification payload round-trips');

// each message must use a fresh salt and ephemeral key, or the key/nonce repeat
const a = await encryptPayload('x', RFC.uaPublic, RFC.auth);
const b = await encryptPayload('x', RFC.uaPublic, RFC.auth);
check(b64urlEncode(a.slice(0, 16)) !== b64urlEncode(b.slice(0, 16)), 'salt is fresh per message');
check(b64urlEncode(a.slice(21, 86)) !== b64urlEncode(b.slice(21, 86)), 'server key is ephemeral per message');

// ---------------------------------------------------------------------------
section('VAPID (RFC 8292)');

// a throwaway signing key, shaped like the secret Dan will paste in
const vapidKeys = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);
const jwk = await crypto.subtle.exportKey('jwk', vapidKeys.privateKey);
const env = { VAPID_JWK: JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }) };

check(pushConfigured(env) === true, 'configured when the secret is present');
check(pushConfigured({}) === false, 'not configured when the secret is absent');

const pub = vapidPublicKey(env);
const pubBytes = b64urlDecode(pub);
check(pubBytes.length === 65 && pubBytes[0] === 4, 'public key is an uncompressed P-256 point');
const exportedPub = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', vapidKeys.publicKey)));
check(pub === exportedPub, 'derived public key matches the keypair it is signed by');

const auth = await vapidAuth(env, 'https://fcm.googleapis.com/fcm/send/abc123');
check(auth.startsWith('vapid t=') && auth.includes(', k='), 'Authorization header is the vapid scheme');
const [, jwt] = auth.match(/^vapid t=([^,]+), k=(.+)$/) || [];
check(auth.endsWith(pub), 'header carries the public key');

const [h64, c64, s64] = jwt.split('.');
const head = JSON.parse(Buffer.from(h64, 'base64url'));
const claims = JSON.parse(Buffer.from(c64, 'base64url'));
check(head.alg === 'ES256' && head.typ === 'JWT', 'JWT header is ES256');
check(claims.aud === 'https://fcm.googleapis.com', 'aud is the push service origin, not the full endpoint');
check(claims.sub.startsWith('mailto:'), 'sub is a contact address');
const life = claims.exp - Math.floor(Date.now() / 1000);
check(life > 0 && life <= 24 * 3600, 'exp is in the future and within the 24h cap');

const sigOk = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' }, vapidKeys.publicKey,
  b64urlDecode(s64), new TextEncoder().encode(`${h64}.${c64}`),
);
check(sigOk, 'signature verifies against the public key we advertise');

// a JWK the dashboard might mangle, or the wrong kind of key entirely
let threw = '';
try { vapidPublicKey({ VAPID_JWK: JSON.stringify({ kty: 'RSA', n: 'x' }) }); } catch (e) { threw = e.message; }
check(/P-256 private JWK/.test(threw), 'a non-P-256 JWK fails loudly with a useful message');

// ---------------------------------------------------------------------------
section('sendPush never disturbs a saga');

const skipped = await sendPush({}, { endpoint: 'https://x/y', p256dh: RFC.uaPublic, auth: RFC.auth }, {});
check(skipped.skipped === true && skipped.ok === false, 'no secret configured: silent no-op, no throw');

const bad = await sendPush(env, { endpoint: 'not-a-url', p256dh: 'zzz', auth: 'zzz' }, {});
check(bad.ok === false && !!bad.error, 'a broken subscription returns an error instead of throwing');

// ---------------------------------------------------------------------------
section('notification text covers every prompt the engine can raise');

// Both tiers word a decision through awaitingText, so a prompt missing from
// its table degrades quietly to "the saga awaits your decision" rather than
// failing. Read the types straight out of the engine so a new prompt has to
// be given words before it can ship.
const engineSrc = readFileSync(new URL('../public/shared/engine.js', import.meta.url), 'utf8');
const types = new Set();
const re = /awaiting\s*=\s*\{[\s\S]{0,200}?type:\s*'([a-z-]+)'/g;
for (let m; (m = re.exec(engineSrc));) types.add(m[1]);

check(types.size >= 16, `found the engine's prompt types (${types.size})`);
const generic = awaitingText('a-type-that-does-not-exist', 'Bjorn');
const missing = [...types].filter(t => awaitingText(t, 'Bjorn') === generic);
check(missing.length === 0, `every prompt type has its own text${missing.length ? `: missing ${missing.join(', ')}` : ''}`);
check(generic === 'Bjorn: the saga awaits your decision', 'an unknown prompt still says something sensible');
check(awaitingText('block', 'Sigrun') === 'A Draugr strikes Sigrun. Brace?', 'the soul is named in the text');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

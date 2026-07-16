/*
 * Generate the VAPID keypair that signs Mirkwood's push notifications.
 *
 *   node tools/vapid-keys.mjs
 *
 * Prints one JSON line to paste into the Cloudflare dashboard as the secret
 * VAPID_JWK (Workers & Pages -> mirkwood -> Settings -> Variables and Secrets,
 * type "Secret"). Nothing else to configure: the public application-server key
 * the browser subscribes with is derived from this JWK at runtime and served
 * from /push-key, so the two can never drift apart.
 *
 * No npm dependency and no wrangler CLI — just Node's WebCrypto, the same
 * primitives the Worker uses.
 *
 * This key is the identity of Mirkwood's push sender. Treat the private half
 * like any other secret: it goes in the dashboard, never in the repo. Losing
 * it is survivable (generate a new one), but every existing subscription
 * stops working, so players would need to toggle the bell off and on again.
 */

const keys = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);

const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
// only the parts the Worker needs, so a stray "use"/"key_ops" field can never
// make importKey reject the pasted secret
const secret = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };

const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
const publicKey = Buffer.from(raw).toString('base64url');

console.log('\nVAPID_JWK  (paste as a Secret in the Cloudflare dashboard)');
console.log('-----------------------------------------------------------');
console.log(JSON.stringify(secret));
console.log('\npublic key (informational — the Worker derives this itself,');
console.log('            and serves it to the client from /push-key)');
console.log('-----------------------------------------------------------');
console.log(publicKey);
console.log('\nAfter saving the secret, confirm the dashboard\'s deploy prompt,');
console.log('then open https://<your-worker>/push-test to verify.\n');

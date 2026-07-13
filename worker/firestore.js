/*
 * Saga telemetry → Firestore, via the REST API with a service-account token.
 *
 * Entirely optional: logSaga() is a silent no-op unless BOTH are configured:
 *   - FIREBASE_PROJECT_ID   (plain var in wrangler.jsonc)
 *   - FIREBASE_SERVICE_ACCOUNT (secret: the full service-account JSON —
 *     `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT` and paste the file)
 *
 * The service-account OAuth token has privileged Datastore access, so no
 * firestore.rules changes are needed for these server-side writes. Documents
 * land in the `sagas` collection, one per finished game.
 */

let tokenCache = { token: null, exp: 0 };

function b64url(input) {
  const bytes = typeof input === 'string'
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToBuf(pem) {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(sa) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuf(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const j = await res.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

// recursive: plain objects become mapValue and arrays arrayValue, so the saga
// doc can carry structured detail (tile counts, perk usage) that groups
// legibly in the Firestore console
function toValue(v) {
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.filter(x => x !== null && x !== undefined).map(toValue) } };
  }
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v).slice(0, 500) };
}
export function toFields(obj) { // exported for the encoder self-test
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    fields[k] = toValue(v);
  }
  return fields;
}

export function telemetryConfigured(env) {
  return !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_SERVICE_ACCOUNT);
}

export async function logSaga(env, doc) {
  if (!telemetryConfigured(env)) return; // telemetry not configured
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const token = await getAccessToken(sa);
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/sagas`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(doc) }),
  });
  if (!res.ok) throw new Error(`firestore write failed: ${res.status} ${await res.text()}`);
}

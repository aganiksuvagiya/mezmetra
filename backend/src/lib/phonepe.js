import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from './errors.js';

// PhonePe Payment Gateway, "Standard Checkout v2" (OAuth). Each restaurant brings its own merchant account, so every call carries
// that restaurant's client id / version / secret and says whether they are PhonePe's sandbox or live ones.
// Docs: developer.phonepe.com -> Payment Gateway -> Website integration -> Standard Checkout -> API integration.
const SANDBOX = { api: 'https://api-preprod.phonepe.com/apis/pg-sandbox', token: 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token' };
const LIVE = { api: 'https://api.phonepe.com/apis/pg', token: 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token' };

/** What a client id / client version may look like (the values come from the PhonePe Business dashboard). */
export const CLIENT_ID_RE = /^[A-Za-z0-9_.-]{4,80}$/;
export const CLIENT_VERSION_RE = /^[A-Za-z0-9_.-]{1,10}$/;

const hostsFor = (env) =>
  config.phonepeApiBase ? { api: config.phonepeApiBase, token: `${config.phonepeApiBase}/v1/oauth/token` } : env === 'live' ? LIVE : SANDBOX;

async function http(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(502, 'PHONEPE_UNREACHABLE', 'Could not reach PhonePe. Please try again in a moment.');
  }
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

// Tokens last days; keep them per restaurant (and per secret, so changing the secret takes effect at once) and refresh a minute early.
const tokens = new Map();
const cacheKey = (c) => `${c.env}|${c.clientId}|${c.clientVersion}|${createHash('sha256').update(c.clientSecret).digest('hex').slice(0, 16)}`;

async function getToken(creds, { force = false } = {}) {
  const key = cacheKey(creds);
  const cached = tokens.get(key);
  if (!force && cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const { res, json } = await http(hostsFor(creds.env).token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_version: creds.clientVersion,
      client_secret: creds.clientSecret,
      grant_type: 'client_credentials',
    }).toString(),
  });
  if (!res.ok || !json.access_token) {
    // Wrong client id / version / secret (or sandbox keys used as live, and the other way round) all end up here.
    throw new HttpError(502, 'PHONEPE_BAD_KEYS', json.message || 'PhonePe did not accept these keys. Check the Client ID, Client Version, Client Secret and whether they are sandbox or live.');
  }
  const expiresAt = Number(json.expires_at) > 0 ? Number(json.expires_at) * 1000 : Date.now() + 5 * 60_000;
  tokens.set(key, { token: json.access_token, expiresAt });
  return json.access_token;
}

async function call(creds, path, { method = 'GET', body } = {}) {
  const url = `${hostsFor(creds.env).api}${path}`;
  const run = async (token) =>
    http(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `O-Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
  let { res, json } = await run(await getToken(creds));
  if (res.status === 401) ({ res, json } = await run(await getToken(creds, { force: true }))); // the token was revoked or expired early
  if (!res.ok) {
    throw new HttpError(502, res.status === 401 ? 'PHONEPE_BAD_KEYS' : 'PHONEPE_ERROR', json.message || json.code || `PhonePe returned HTTP ${res.status}`);
  }
  return json;
}

/**
 * Starts a payment. `merchantOrderId` is our own unique id for this attempt (letters, digits, '_' and '-', at most 63 characters);
 * the diner is sent to the returned `redirectUrl` and comes back to `returnUrl`. Amounts are in paise (PhonePe's minimum is 100).
 */
export const createPhonepePayment = (creds, { merchantOrderId, amountPaise, returnUrl, message, expireAfterSeconds = 1800 }) =>
  call(creds, '/checkout/v2/pay', {
    method: 'POST',
    body: {
      merchantOrderId,
      amount: amountPaise,
      expireAfter: expireAfterSeconds,
      paymentFlow: { type: 'PG_CHECKOUT', message, merchantUrls: { redirectUrl: returnUrl } },
    },
  }).then((r) => {
    if (!r.redirectUrl) throw new HttpError(502, 'PHONEPE_ERROR', 'PhonePe did not return a payment page.');
    return r;
  });

/** The order as PhonePe sees it: `state` is PENDING, COMPLETED or FAILED. This is the source of truth for "paid". */
export const getPhonepeOrderStatus = (creds, merchantOrderId) => call(creds, `/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status?details=false`);

/** Gives (part of) a payment back. `state` of the answer is PENDING at first, then COMPLETED or FAILED. */
export const refundPhonepe = (creds, { merchantRefundId, originalMerchantOrderId, amountPaise }) =>
  call(creds, '/payments/v2/refund', { method: 'POST', body: { merchantRefundId, originalMerchantOrderId, amount: amountPaise } });

/** Used by the admin "Test connection" button: asking for a token proves the three keys and the sandbox/live choice. */
export const pingPhonepe = (creds) => getToken(creds, { force: true }).then(() => true);

/** What PhonePe sends in the webhook's Authorization header: SHA256("username:password"), as hex (the username and password are typed in PhonePe's dashboard). */
export const phonepeWebhookAuth = (username, password) => createHash('sha256').update(`${username}:${password}`).digest('hex');

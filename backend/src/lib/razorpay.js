import { config } from '../config.js';
import { HttpError } from './errors.js';
import { hmacSha256Hex, safeEqual } from './crypto.js';

const authHeader = (keyId, keySecret) => `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

async function call(path, { keyId, keySecret, method = 'GET', body }) {
  let res;
  try {
    res = await fetch(`${config.razorpayApiBase}${path}`, {
      method,
      headers: { Authorization: authHeader(keyId, keySecret), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, 'RAZORPAY_UNREACHABLE', 'Could not reach Razorpay. Please try again in a moment.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json?.error?.description || `Razorpay returned HTTP ${res.status}`;
    // 401 means the vendor's saved keys are wrong; surface that clearly to the admin, not to the diner.
    throw new HttpError(502, res.status === 401 ? 'RAZORPAY_BAD_KEYS' : 'RAZORPAY_ERROR', reason);
  }
  return json;
}

export const createRazorpayOrder = ({ keyId, keySecret, amountPaise, currency, receipt, notes }) =>
  call('/orders', { keyId, keySecret, method: 'POST', body: { amount: amountPaise, currency, receipt, notes } });

/** Cheap authenticated call used by the admin "Test connection" button. */
export const pingRazorpay = ({ keyId, keySecret }) => call('/orders?count=1', { keyId, keySecret });

/** Checkout success signature = HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret). */
export function verifyCheckoutSignature({ keySecret, orderId, paymentId, signature }) {
  return safeEqual(hmacSha256Hex(keySecret, `${orderId}|${paymentId}`), String(signature));
}

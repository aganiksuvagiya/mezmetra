import { config } from '../config.js';
import { HttpError } from './errors.js';
import { hmacSha256Hex, safeEqual } from './crypto.js';

/**
 * May this Key ID take a diner's money here? On the live server only a live key may: a test key's payments are pretend, so anyone
 * could get an order marked "Paid" without paying.
 */
export const isUsableKeyId = (keyId) => !config.razorpayLiveOnly || String(keyId ?? '').startsWith('rzp_live_');

/** True when these payment settings hold Razorpay keys that can be used here. */
export const razorpayReady = (s) => Boolean(s?.razorpay_key_id && s.razorpay_key_secret_enc && isUsableKeyId(s.razorpay_key_id));

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
    const err = new HttpError(502, res.status === 401 ? 'RAZORPAY_BAD_KEYS' : 'RAZORPAY_ERROR', reason);
    err.gatewayStatus = res.status; // tells a refusal (4xx) from an answer that says nothing (5xx)
    throw err;
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

/** A webhook is signed with the secret typed in Razorpay's dashboard: HMAC_SHA256(raw request body, webhook secret), as hex. */
export function verifyWebhookSignature({ secret, rawBody, signature }) {
  return safeEqual(hmacSha256Hex(secret, rawBody), String(signature ?? ''));
}

/** Whether a Razorpay payment is enough for the attempt. It may be more, when the account makes the diner pay Razorpay's fee; never less. */
export const coversAmount = (paid, expectedPaise) => Number(paid) >= Number(expectedPaise);

/** One payment as Razorpay sees it: `status` is created, authorized, captured, refunded or failed. Only `captured` money is the restaurant's. */
export const fetchRazorpayPayment = ({ keyId, keySecret, paymentId }) => call(`/payments/${encodeURIComponent(paymentId)}`, { keyId, keySecret });

/** Takes an authorized payment, for accounts that do not capture by themselves (an authorization alone is given back after a few days). */
export const captureRazorpayPayment = ({ keyId, keySecret, paymentId, amountPaise, currency }) =>
  call(`/payments/${encodeURIComponent(paymentId)}/capture`, { keyId, keySecret, method: 'POST', body: { amount: amountPaise, currency } });

/** The payments made on a Razorpay order (items with status "captured" are money that arrived). */
export const fetchRazorpayOrderPayments = ({ keyId, keySecret, orderId }) => call(`/orders/${encodeURIComponent(orderId)}/payments`, { keyId, keySecret });

/**
 * A UPI QR code for one order: single use, and the amount is fixed, so the diner's UPI app cannot change it. Razorpay must have
 * activated "UPI QR" for the merchant (it is an on-demand feature). `closeBy` is a UNIX time (at least 2 minutes from now).
 */
export const createRazorpayQr = ({ keyId, keySecret, amountPaise, name, description, notes, closeBy }) =>
  call('/payments/qr_codes', {
    keyId,
    keySecret,
    method: 'POST',
    body: { type: 'upi_qr', name, usage: 'single_use', fixed_amount: true, payment_amount: amountPaise, description, close_by: closeBy, notes },
  });

/** The QR code itself (its `image_url` is the picture to show). */
export const fetchRazorpayQr = ({ keyId, keySecret, qrId }) => call(`/payments/qr_codes/${encodeURIComponent(qrId)}`, { keyId, keySecret });

/** Closes a QR code, so that nobody can pay on it any more. */
export const closeRazorpayQr = ({ keyId, keySecret, qrId }) => call(`/payments/qr_codes/${encodeURIComponent(qrId)}/close`, { keyId, keySecret, method: 'POST' });

/** A refund as Razorpay sees it: `status` is pending, processed or failed. */
export const fetchRazorpayRefund = ({ keyId, keySecret, refundId }) => call(`/refunds/${encodeURIComponent(refundId)}`, { keyId, keySecret });

/** Every refund of one payment: `{ items: [{ id, amount, status }] }`, whoever asked for it. */
export const fetchRazorpayPaymentRefunds = ({ keyId, keySecret, paymentId }) => call(`/payments/${encodeURIComponent(paymentId)}/refunds`, { keyId, keySecret });

/** The payments made on a QR code: `{ items: [{ id, amount, status }] }`. A `captured` item means the money arrived. */
export const fetchRazorpayQrPayments = ({ keyId, keySecret, qrId }) =>
  call(`/payments/qr_codes/${encodeURIComponent(qrId)}/payments`, { keyId, keySecret });

/** Refunds a captured payment in full. Razorpay answers with the refund (`id`, `status` processed or pending). */
export const refundRazorpayPayment = ({ keyId, keySecret, paymentId, amountPaise, notes }) =>
  call(`/payments/${encodeURIComponent(paymentId)}/refund`, { keyId, keySecret, method: 'POST', body: { amount: amountPaise, speed: 'normal', notes } });

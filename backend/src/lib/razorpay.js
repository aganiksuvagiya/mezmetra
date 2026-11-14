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

/** The payments made on a QR code: `{ items: [{ id, amount, status }] }`. A `captured` item means the money arrived. */
export const fetchRazorpayQrPayments = ({ keyId, keySecret, qrId }) =>
  call(`/payments/qr_codes/${encodeURIComponent(qrId)}/payments`, { keyId, keySecret });

/** Refunds a captured payment in full. Razorpay answers with the refund (`id`, `status` processed or pending). */
export const refundRazorpayPayment = ({ keyId, keySecret, paymentId, amountPaise, notes }) =>
  call(`/payments/${encodeURIComponent(paymentId)}/refund`, { keyId, keySecret, method: 'POST', body: { amount: amountPaise, speed: 'normal', notes } });

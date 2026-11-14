import { config } from '../config.js';
import { HttpError } from './errors.js';

// Cashfree Payments (PG) REST API. Each restaurant uses its own App ID + Secret Key, so every call carries them.
const API_VERSION = '2023-08-01';
const SANDBOX = 'https://sandbox.cashfree.com/pg';
const PRODUCTION = 'https://api.cashfree.com/pg';

/** What an App ID may look like (letters, digits, '_' and '-'). */
export const APP_ID_RE = /^[A-Za-z0-9_-]{6,60}$/;

/** Cashfree's test (sandbox) App IDs start with "TEST"; every other App ID belongs to a live account. */
export const cashfreeMode = (appId) => (/^TEST/i.test(String(appId ?? '')) ? 'sandbox' : 'production');

const baseFor = (appId) => config.cashfreeApiBase || (cashfreeMode(appId) === 'sandbox' ? SANDBOX : PRODUCTION);

async function call(path, { appId, secret, method = 'GET', body, allow404 = false }) {
  let res;
  try {
    res = await fetch(`${baseFor(appId)}${path}`, {
      method,
      headers: {
        'x-client-id': appId,
        'x-client-secret': secret,
        'x-api-version': API_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, 'CASHFREE_UNREACHABLE', 'Could not reach Cashfree. Please try again in a moment.');
  }
  const json = await res.json().catch(() => ({}));
  if (allow404 && res.status === 404) return null;
  if (!res.ok) {
    const reason = json?.message || `Cashfree returned HTTP ${res.status}`;
    // 401 means the vendor's saved App ID / Secret Key are wrong; surface that clearly to the admin, not to the diner.
    throw new HttpError(502, res.status === 401 ? 'CASHFREE_BAD_KEYS' : 'CASHFREE_ERROR', reason);
  }
  return json;
}

/**
 * Creates the order the diner pays for. `orderId` is our own unique id for this attempt (letters, digits, '_' and '-').
 * Cashfree insists on a customer phone number and we do not ask diners for one, so a fixed placeholder is sent.
 */
export const createCashfreeOrder = ({ appId, secret, orderId, amountPaise, customerId, returnUrl, note }) =>
  call('/orders', {
    appId,
    secret,
    method: 'POST',
    body: {
      order_id: orderId,
      order_amount: Number((amountPaise / 100).toFixed(2)),
      order_currency: 'INR',
      customer_details: { customer_id: customerId, customer_phone: '9999999999' },
      order_meta: { return_url: returnUrl },
      order_note: note,
    },
  });

/** The order as Cashfree sees it: order_status is ACTIVE, PAID, EXPIRED or TERMINATED. This is the source of truth for "paid". */
export const getCashfreeOrder = ({ appId, secret, orderId }) => call(`/orders/${encodeURIComponent(orderId)}`, { appId, secret });

/** The payment attempts on an order (used to record Cashfree's payment id for a paid order). */
export const getCashfreePayments = ({ appId, secret, orderId }) => call(`/orders/${encodeURIComponent(orderId)}/payments`, { appId, secret });

/**
 * Cheap authenticated call used by the admin "Test connection" button. Cashfree has no "who am I" call, so we look up an order
 * that cannot exist: wrong keys answer 401, right keys answer "order not found".
 */
export const pingCashfree = ({ appId, secret }) => call('/orders/mezmitra_connection_check', { appId, secret, allow404: true });

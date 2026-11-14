// Thin fetch wrapper for the public MezMitra API (see API.md). The server prices everything; we never send prices.

const API_BASE = import.meta.env.VITE_API_URL ?? '';
const TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor({ status = 0, code = 'UNKNOWN', message, details }) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // 0 = never reached the server
    this.code = code;
    this.details = details;
  }

  get isNetwork() {
    return this.status === 0;
  }
}

export const isAbort = (err) => err?.name === 'AbortError';

/** Prefix an API path (also used for `photo_url`) with the configured API origin. */
export const assetUrl = (path) => {
  if (!path) return null;
  return /^https?:\/\//i.test(path) ? path : `${API_BASE}${path}`;
};

const fallbackMessage = (status) => {
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
  if (status === 404) return "We couldn't find that.";
  return 'Something went wrong. Please try again.';
};

async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err; // the caller cancelled on purpose - not an error to show
      throw new ApiError({
        status: 0,
        code: timedOut ? 'TIMEOUT' : 'NETWORK',
        message: timedOut
          ? 'The server is taking too long to respond. Please try again.'
          : "We couldn't reach the server. Check your internet connection and try again.",
      });
    }

    let json = null;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body (e.g. a proxy error page) - handled below */
    }

    if (res.ok) {
      if (res.status === 204) return null;
      if (json && 'data' in json) return json.data;
      throw new ApiError({ status: res.status, code: 'BAD_RESPONSE', message: fallbackMessage(500) });
    }

    const e = json?.error;
    throw new ApiError({
      status: res.status,
      code: e?.code ?? `HTTP_${res.status}`,
      message: e?.message || fallbackMessage(res.status),
      details: e?.details,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A message that is safe and useful to show a diner. Server `message`s are written for people, except the
 * generic validation text ("items.0.quantity: ..."), which we replace with the caller's friendlier fallback.
 */
export function errorMessage(err, fallback = 'Something went wrong. Please try again.') {
  if (!(err instanceof ApiError)) return fallback;
  if (err.status === 0) return err.message;
  if (err.status >= 500) return fallbackMessage(500);
  if (['VALIDATION_ERROR', 'BAD_JSON', 'BAD_REQUEST'].includes(err.code)) return fallback;
  return err.message || fallback;
}

const enc = encodeURIComponent;

export const getMenu = (tableToken, opts) => request(`/api/public/t/${enc(tableToken)}`, opts);

export const createOrder = (tableToken, payload, idempotencyKey, opts) =>
  request(`/api/public/t/${enc(tableToken)}/orders`, {
    ...opts,
    method: 'POST',
    body: payload,
    headers: { 'Idempotency-Key': idempotencyKey },
  });

export const getOrder = (orderToken, opts) => request(`/api/public/orders/${enc(orderToken)}`, opts);

/** The diner says they paid through a UPI app. Staff still confirm it; this never marks the order paid. */
export const claimUpiPayment = (orderToken, reference) =>
  request(`/api/public/orders/${enc(orderToken)}/upi-claim`, {
    method: 'POST',
    body: reference ? { reference } : {},
  });

export const startRazorpay = (orderToken) =>
  request(`/api/public/orders/${enc(orderToken)}/razorpay`, { method: 'POST' });

/** Cashfree: the server creates the payment session; later it asks Cashfree whether the money arrived (nothing is sent from here). */
export const startCashfree = (orderToken) =>
  request(`/api/public/orders/${enc(orderToken)}/cashfree`, { method: 'POST' });

export const verifyCashfree = (orderToken) =>
  request(`/api/public/orders/${enc(orderToken)}/cashfree/verify`, { method: 'POST' });

/** Which waiter / bill requests of this table are open: { waiter, bill }. */
export const getServiceRequests = (tableToken, opts) => request(`/api/public/t/${enc(tableToken)}/requests`, opts);

/** "Call the waiter" (kind 'waiter') or "Ask for the bill" (kind 'bill'). Asking again just reports the one already waiting. */
export const askService = (tableToken, kind) =>
  request(`/api/public/t/${enc(tableToken)}/requests`, { method: 'POST', body: { kind } });

/** A Razorpay UPI QR code for this order (scan it with any UPI app). The server checks with Razorpay whether it was paid. */
export const startRazorpayQr = (orderToken) =>
  request(`/api/public/orders/${enc(orderToken)}/razorpay-qr`, { method: 'POST' });

export const verifyRazorpayQr = (orderToken) =>
  request(`/api/public/orders/${enc(orderToken)}/razorpay-qr/verify`, { method: 'POST' });

export const verifyRazorpay = (orderToken, response) =>
  request(`/api/public/orders/${enc(orderToken)}/razorpay/verify`, {
    method: 'POST',
    body: {
      razorpay_order_id: response.razorpay_order_id,
      razorpay_payment_id: response.razorpay_payment_id,
      razorpay_signature: response.razorpay_signature,
    },
  });

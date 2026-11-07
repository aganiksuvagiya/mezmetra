import { auth } from './auth.js';

export const API_BASE = import.meta.env.VITE_API_URL ?? '';

/** Turns an API-relative path (like `/api/public/items/7/photo?v=2`) into a URL the browser can load. */
export const apiUrl = (path) => (/^https?:\/\//.test(path) ? path : `${API_BASE}${path}`);

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'ERROR', details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// AuthProvider registers a handler so a 401 anywhere sends the person back to /login.
let unauthorizedHandler = null;
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
  return () => {
    if (unauthorizedHandler === fn) unauthorizedHandler = null;
  };
}

function buildUrl(path, query) {
  const url = apiUrl(path);
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return url;
  return url + (url.includes('?') ? '&' : '?') + qs;
}

const FALLBACK_MESSAGES = {
  413: 'That file is too large.',
  415: 'That file type is not supported.',
  429: 'Too many requests. Please wait a moment and try again.',
};

async function readError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON (for example a proxy error page) */
  }
  const err = body?.error;
  if (err?.message) {
    return new ApiError(err.message, { status: res.status, code: err.code ?? 'ERROR', details: err.details });
  }
  const message =
    FALLBACK_MESSAGES[res.status] ??
    (res.status >= 500 ? 'The server is not responding right now. Please try again in a moment.' : `Request failed (${res.status}).`);
  return new ApiError(message, { status: res.status, code: res.status >= 500 ? 'SERVER' : 'ERROR' });
}

/**
 * Low-level request. Returns the Response for 2xx, throws ApiError otherwise.
 * `body` may be a plain object (sent as JSON) or a Blob (sent raw with its own Content-Type).
 * Pass `auth: false` for the login/signup calls (a 401 there means "wrong password", not "session expired").
 */
async function request(path, { method = 'GET', body, query, headers = {}, auth: needsAuth = true, signal } = {}) {
  const finalHeaders = { Accept: 'application/json', ...headers };
  let payload;
  if (body instanceof Blob) {
    payload = body;
    finalHeaders['Content-Type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    finalHeaders['Content-Type'] = 'application/json';
  }
  if (needsAuth) {
    const token = auth.getToken();
    if (token) finalHeaders.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(buildUrl(path, query), { method, headers: finalHeaders, body: payload, signal });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new ApiError('Cannot reach the server. Check your connection and try again.', { status: 0, code: 'NETWORK' });
  }

  if (res.ok) return res;
  const error = await readError(res);
  if (res.status === 401 && needsAuth) {
    auth.clear();
    unauthorizedHandler?.();
  }
  throw error;
}

/** JSON call. Resolves to the unwrapped `data` (null for 204). */
export async function api(path, options) {
  const res = await request(path, options);
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  return json?.data ?? null;
}

/** JSON call for list endpoints. Resolves to `{ data, meta }`. */
export async function apiPage(path, options) {
  const res = await request(path, options);
  const json = await res.json().catch(() => null);
  return { data: json?.data ?? [], meta: json?.meta ?? {} };
}

/** Authenticated binary download (QR images, PDF receipts). Resolves to a Blob. */
export async function apiBlob(path, options) {
  const res = await request(path, { ...options, headers: { Accept: '*/*', ...options?.headers } });
  return res.blob();
}

/** Maps a validation error's `details` to `{ field: message }` plus a leftover message for the form. */
export function splitFieldErrors(error, knownFields) {
  const fields = {};
  const rest = [];
  if (error instanceof ApiError && Array.isArray(error.details)) {
    for (const d of error.details) {
      const field = String(d.field ?? '').split('.')[0];
      if (knownFields.includes(field)) {
        if (!fields[field]) fields[field] = d.message;
      } else {
        rest.push(d.message);
      }
    }
  }
  const formError = rest[0] ?? (Object.keys(fields).length ? null : error?.message || 'Something went wrong. Please try again.');
  return { fields, formError };
}

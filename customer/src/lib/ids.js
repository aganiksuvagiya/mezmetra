export const TABLE_TOKEN_RE = /^[a-f0-9]{32}$/;

/**
 * Accepts a full table link (".../t/<32 hex>", with or without protocol, trailing slash, query or hash) or just
 * the 32-hex token. Returns the lower-cased token, or null when the text is not a table link.
 */
export function parseTableLink(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (TABLE_TOKEN_RE.test(text.toLowerCase())) return text.toLowerCase();
  const path = text.split(/[?#]/)[0].replace(/\/+$/, '');
  const match = path.match(/\/t\/([a-f0-9]{32})$/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * A v4 UUID. crypto.randomUUID() only exists in secure contexts (HTTPS / localhost), so testing the app from a
 * phone over a plain-http LAN address would break without the getRandomValues fallback.
 */
export function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < b.length; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

import { getJSON, removeItem, setJSON } from './storage';
import { uuid } from './ids';

// One Idempotency-Key per checkout attempt. The same key + the same cart always returns the same order, so
// retries after a flaky network (or a double tap) can never create a second order. When the cart changes we
// mint a new key; after a successful order the key is discarded.

const keyName = (tableToken) => `mezmitra_idem_${tableToken}`;
const TTL_MS = 2 * 60 * 60 * 1000;
const memory = new Map(); // fallback when localStorage is blocked

/** `fingerprint` identifies the cart contents (see CartPage). */
export function idempotencyKeyFor(tableToken, fingerprint) {
  const name = keyName(tableToken);
  const stored = getJSON(name) ?? memory.get(name);
  if (stored && stored.fp === fingerprint && typeof stored.key === 'string' && Date.now() - stored.at < TTL_MS) {
    return stored.key;
  }
  const record = { fp: fingerprint, key: uuid(), at: Date.now() };
  memory.set(name, record);
  setJSON(name, record);
  return record.key;
}

export function clearIdempotencyKey(tableToken) {
  memory.delete(keyName(tableToken));
  removeItem(keyName(tableToken));
}

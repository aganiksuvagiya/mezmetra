// Time-based one-time passwords (RFC 6238: HMAC-SHA1, 6 digits, 30 seconds), as every authenticator app makes them.
import { createHash, createHmac, randomBytes } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

export function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of String(text).toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = ((value << 5) | index) & 0xffffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / PERIOD);

export function totpCode(secret, step = stepAt()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The time step `code` belongs to (now, or one step either side for clocks that differ), newer than `after`; otherwise null. */
export function verifyTotp(secret, code, { after = 0, now = Date.now() } = {}) {
  const typed = String(code ?? '').replace(/\s/g, '');
  const current = stepAt(now);
  for (const step of [current, current - 1, current + 1]) {
    if (step > after && totpCode(secret, step) === typed) return step;
  }
  return null;
}

export const otpauthUrl = (secret, email) =>
  `otpauth://totp/${encodeURIComponent(`MezMitra:${email}`)}?secret=${secret}&issuer=MezMitra&algorithm=SHA1&digits=6&period=${PERIOD}`;

// Recovery codes: for the day the phone is lost. Shown once, kept as hashes, each works once.
const tidy = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
export const hashRecoveryCode = (code) => createHash('sha256').update(tidy(code)).digest('hex');
export const newRecoveryCodes = (count = 8) =>
  Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });

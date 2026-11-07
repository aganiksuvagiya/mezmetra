import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// Per-vendor payment secrets are stored encrypted (AES-256-GCM) with a key derived from APP_SECRET.
// The "tableseva" label is part of the key derivation (the product's former name). Do not rename it: stored secrets would become unreadable.
const key = createHash('sha256').update(`tableseva:secrets:${config.appSecret}`).digest();

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(blob) {
  const [version, iv, tag, enc] = String(blob).split(':');
  if (version !== 'v1' || !iv || !tag || !enc) throw new Error('Unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
}

export function hmacSha256Hex(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

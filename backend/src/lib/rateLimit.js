import { isIP } from 'node:net';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

/**
 * The visitor's own address. Behind a CDN that puts it in a header of its own (CLIENT_IP_HEADER, for example Cloudflare's
 * `cf-connecting-ip`), that header; otherwise Express's `req.ip`, which TRUST_PROXY controls. The header is read only when it is
 * configured: set it only where every request really passes through the proxy that writes it, or a client could make one up.
 */
export function clientIp(req) {
  if (config.clientIpHeader) {
    const value = String(req.get(config.clientIpHeader) ?? '').trim();
    if (isIP(value)) return value;
  }
  return req.ip ?? '';
}

/** The address as a counter key (IPv6 addresses are grouped by network, so one machine cannot rotate through its own range). */
export const ipKey = (req) => ipKeyGenerator(clientIp(req));

/** Counts one more hit on `key` within a window, atomically. Returns { hits, resetAt }. */
export async function hit(db, key, windowMs) {
  const { rows } = await db.query(
    `INSERT INTO rate_limits AS r (key, hits, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2))
     ON CONFLICT (key) DO UPDATE SET
       hits     = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.hits + 1 END,
       reset_at = CASE WHEN r.reset_at <= now() THEN EXCLUDED.reset_at ELSE r.reset_at END
     RETURNING hits, reset_at`,
    [key, windowMs / 1000],
  );
  return { hits: Number(rows[0].hits), resetAt: new Date(rows[0].reset_at) };
}

/** Takes one hit back (an attempt that turned out to be legitimate). */
export const unhit = (db, key) => db.query(`UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1`, [key]);

export const forget = (db, key) => db.query(`DELETE FROM rate_limits WHERE key = $1`, [key]);

/** Removes a counter and the ones kept under it (`key` and everything starting `key:`). */
export const forgetAll = (db, key) => db.query(`DELETE FROM rate_limits WHERE key = $1 OR starts_with(key, $1 || ':')`, [key]);

// Once the tries from everywhere together are used up, an address may still make this many: someone guessing from many addresses gets
// next to nothing, and cannot shut out the people the account or table belongs to.
const TRIES_AFTER_LOCK_FOR_A_NEW_ADDRESS = 3;

/**
 * Counts a try against `key` from this address and against `key` from everywhere, before the secret is looked at (so tries made at
 * once cannot slip past). Tries from an address that is locked already do not count against everyone else.
 * Returns { locked, undo } - `undo()` takes the counts back for a try that turns out to be right.
 */
export async function guardedTry(db, key, req, { windowMs, perAddress, inAll }) {
  const mine = `${key}:${ipKey(req)}`;
  const here = await hit(db, mine, windowMs);
  if (here.hits > perAddress) return { locked: true };
  const everywhere = await hit(db, key, windowMs);
  if (everywhere.hits > inAll && here.hits > TRIES_AFTER_LOCK_FOR_A_NEW_ADDRESS) return { locked: true };
  return { locked: false, mine, undo: () => Promise.all([unhit(db, mine), unhit(db, key)]) };
}

/** Removes counters whose window passed a while ago. */
export const sweepRateLimits = (db) => db.query(`DELETE FROM rate_limits WHERE reset_at < now() - interval '1 hour'`);

/** express-rate-limit's store interface on top of the same table. */
export class DbRateStore {
  constructor(db, name) {
    this.db = db;
    this.prefix = `${name}:`;
    this.localKeys = false;
    this.windowMs = 60_000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const { hits, resetAt } = await hit(this.db, this.prefix + key, this.windowMs);
    return { totalHits: hits, resetTime: resetAt };
  }

  async decrement(key) {
    // express-rate-limit does not wait for this one: a failure must not become an unhandled rejection, which would stop the server.
    try {
      await unhit(this.db, this.prefix + key);
    } catch (err) {
      console.warn('[rate-limit] could not take a try back:', err.message);
    }
  }

  async resetKey(key) {
    await forget(this.db, this.prefix + key);
  }
}

const tooMany = (_req, res) =>
  res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' } });

const limiter = (options) =>
  rateLimit({ standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: ipKey, handler: tooMany, ...options });

/**
 * The limits, per visitor address. A restaurant's diners usually share one Wi-Fi address, so the limits for reading and for
 * asking "has my payment arrived?" leave room for many of them at once.
 */
export function createLimits(db) {
  const shared = (name, windowMs, limit, extra = {}) => limiter({ windowMs, limit, store: new DbRateStore(db, name), ...extra });
  const local = (windowMs, limit) => limiter({ windowMs, limit });
  return {
    // Only failed sign-ins use up the allowance.
    loginLimiter: shared('login', 15 * 60_000, 20, { skipSuccessfulRequests: true }),
    // Password reset and password changes.
    accountLimiter: shared('account', 15 * 60_000, 20),
    orderLimiter: shared('order', 60_000, 60),
    payLimiter: shared('pay', 60_000, 60),
    checkLimiter: shared('check', 60_000, 300),
    // High volume and harmless: counted in memory, per instance.
    publicLimiter: local(60_000, 900),
    webhookLimiter: local(60_000, 1200),
    // Checks inside the routes that count tries per account and per table (sign-in, table codes).
    guards: true,
  };
}

const passThrough = (_req, _res, next) => next();

/** The same names with nothing behind them (tests that are not about limits). */
export const noLimits = {
  ...Object.fromEntries(
    ['loginLimiter', 'accountLimiter', 'orderLimiter', 'payLimiter', 'checkLimiter', 'publicLimiter', 'webhookLimiter'].map((name) => [name, passThrough]),
  ),
  guards: false,
};

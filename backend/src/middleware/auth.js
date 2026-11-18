import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { forbidden, suspended, unauthorized } from '../lib/errors.js';
import { isSuperAdminEmail } from '../lib/serialize.js';

/**
 * A login token for a restaurant. The platform owner's "log in as" makes a short-lived one that also names the owner (`imp`), so
 * the admin can show "you are viewing this restaurant as the owner" and the owner's own session is never touched.
 */
export function signToken(vendorId, { impersonatedBy, expiresIn } = {}) {
  const payload = { sub: String(vendorId) };
  if (impersonatedBy) payload.imp = String(impersonatedBy);
  return jwt.sign(payload, config.appSecret, { expiresIn: expiresIn ?? config.jwtExpiresIn, algorithm: 'HS256' });
}

/** Requires `Authorization: Bearer <jwt>` and sets req.vendorId. */
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return next(unauthorized('Sign in to continue'));
  try {
    const payload = jwt.verify(token, config.appSecret, { algorithms: ['HS256'] });
    req.vendorId = Number(payload.sub);
    req.tokenIssuedAt = Number(payload.iat) || 0; // seconds
    req.impersonatedBy = payload.imp ? Number(payload.imp) : null; // set when the platform owner is looking at this restaurant
    if (!Number.isSafeInteger(req.vendorId)) throw new Error('bad subject');
    next();
  } catch {
    next(unauthorized('Your session has expired. Please sign in again.'));
  }
}

/**
 * Runs after requireAuth. Looks the restaurant up so that a deleted account, or one the platform owner suspended, is
 * turned away on its very next request (a signed token alone is not enough). Sets req.vendorEmail.
 */
export function requireActiveVendor(db) {
  return async (req, _res, next) => {
    try {
      const { rows } = await db.query(`SELECT email, suspended_at, suspended_reason, password_changed_at FROM vendors WHERE id = $1`, [req.vendorId]);
      const vendor = rows[0];
      if (!vendor) throw unauthorized('Account no longer exists');
      if (vendor.suspended_at) throw suspended(vendor.suspended_reason);
      // A password change signs out every session that started before it.
      if (vendor.password_changed_at && req.tokenIssuedAt < Math.floor(new Date(vendor.password_changed_at).getTime() / 1000)) {
        throw unauthorized('Your password was changed. Please sign in again.');
      }
      req.vendorEmail = vendor.email;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Runs after requireActiveVendor: only the accounts listed in SUPER_ADMIN_EMAILS may continue. */
export function requireSuperAdmin(req, _res, next) {
  if (!isSuperAdminEmail(req.vendorEmail)) return next(forbidden('Only the platform owner can do this'));
  return next();
}

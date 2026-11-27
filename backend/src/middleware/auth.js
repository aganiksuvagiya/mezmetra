import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { forbidden, suspended, unauthorized } from '../lib/errors.js';
import { isSuperAdminEmail } from '../lib/serialize.js';

/**
 * A login token for a restaurant. Only a sign-in makes one: nobody (the platform owner included) can get a session for a restaurant they did not sign in as.
 * A kitchen login (`staffId`) gets a token for the same restaurant that says so (`role: 'kitchen'`), and the API lets it do the kitchen's work only.
 */
export function signToken(vendorId, { staffId } = {}) {
  // `jti` names this one session, so that signing out can end it before it expires.
  const payload = { sub: String(vendorId), jti: randomUUID() };
  if (staffId) {
    payload.role = 'kitchen';
    payload.stf = String(staffId);
  }
  return jwt.sign(payload, config.appSecret, { expiresIn: config.jwtExpiresIn, algorithm: 'HS256' });
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
    req.tokenId = typeof payload.jti === 'string' ? payload.jti : null;
    req.tokenExpiresAt = Number(payload.exp) || 0; // seconds
    req.sessionKey = req.tokenId ?? `at${req.tokenIssuedAt}`; // names this sign-in (sessions from before `jti` go by their time)
    req.staffId = payload.role === 'kitchen' && payload.stf ? Number(payload.stf) : null; // set for a kitchen login
    if (payload.role === 'kitchen' && !Number.isSafeInteger(req.staffId)) throw new Error('bad staff');
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
      const { rows } = await db.query(
        `SELECT email, suspended_at, suspended_reason, password_changed_at,
                EXISTS (SELECT 1 FROM revoked_tokens r WHERE r.jti = $2) AS signed_out
           FROM vendors WHERE id = $1`,
        [req.vendorId, req.tokenId],
      );
      const vendor = rows[0];
      if (!vendor) throw unauthorized('Account no longer exists');
      if (vendor.signed_out) throw unauthorized('You have signed out. Please sign in again.');
      if (vendor.suspended_at) throw suspended(vendor.suspended_reason);
      // A password change signs out every session that started before it.
      if (vendor.password_changed_at && req.tokenIssuedAt < Math.floor(new Date(vendor.password_changed_at).getTime() / 1000)) {
        throw unauthorized('Your password was changed. Please sign in again.');
      }
      req.vendorEmail = vendor.email;
      if (req.staffId) {
        // A kitchen login: it must still exist (removing it signs the kitchen out) and not be older than its last password change.
        const staff = await db.query(`SELECT password_changed_at FROM vendor_staff WHERE id = $1 AND vendor_id = $2`, [req.staffId, req.vendorId]);
        if (!staff.rows[0]) throw unauthorized('This kitchen login was removed. Please sign in again.');
        const changed = staff.rows[0].password_changed_at;
        if (changed && req.tokenIssuedAt < Math.floor(new Date(changed).getTime() / 1000)) throw unauthorized('The kitchen password was changed. Please sign in again.');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Runs after requireActiveVendor: only the accounts listed in SUPER_ADMIN_EMAILS may continue. */
export function requireSuperAdmin(req, _res, next) {
  // A kitchen login of the owner's own restaurant carries the owner's email, but it is not the owner.
  if (req.staffId || !isSuperAdminEmail(req.vendorEmail)) return next(forbidden('Only the platform owner can do this'));
  return next();
}

// What a kitchen login may do in the restaurant's admin API: look at the orders, accept (or refuse) one, and mark one ready. Nothing else:
// not the menu, tables, payments, reports or settings, and not completing an order (that is staff taking the money).
const KITCHEN_CAN = [
  ['GET', /^\/orders\/?$/],
  ['GET', /^\/orders\/\d+$/],
  ['PATCH', /^\/orders\/\d+\/status$/, (req) => ['accepted', 'cancelled'].includes(req.body?.status)],
  ['POST', /^\/orders\/\d+\/ready$/],
];

/** Mounted after requireActiveVendor on the admin API. A normal restaurant login passes untouched. */
export function kitchenGuard(req, _res, next) {
  if (!req.staffId) return next();
  const ok = KITCHEN_CAN.some(([method, path, check]) => req.method === method && path.test(req.path) && (!check || check(req)));
  return next(ok ? undefined : forbidden('The kitchen login can only work with orders.'));
}

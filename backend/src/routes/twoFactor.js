import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { record } from '../lib/audit.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { conflict, forbidden, HttpError, parse } from '../lib/errors.js';
import { checkOwnPassword } from '../lib/passwords.js';
import { forget, hit } from '../lib/rateLimit.js';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';

// Two-step sign-in for a restaurant's own login (the platform owner's above all): after the password, a code from an authenticator
// app, or one of the recovery codes. Mounted behind requireAuth + requireActiveVendor under /api/auth/2fa.

const passwordSchema = z.object({ password: z.string().min(1, 'Enter your password').max(200) });
const codeSchema = z.object({ code: z.string().trim().min(6, 'Enter the 6-digit code').max(20) });
const disableSchema = passwordSchema.extend(codeSchema.shape);

/**
 * Checks a code typed at sign-in or when switching two-step sign-in off, and uses it up (an authenticator code cannot be sent twice,
 * a recovery code is gone after one use). Resolves to true when it was right. `q` is the database or a transaction.
 */
export async function useSecondStep(q, vendor, code) {
  let step = null;
  try {
    step = verifyTotp(decryptSecret(vendor.totp_secret_enc), code, { after: Number(vendor.totp_last_step ?? 0) });
  } catch {
    // Stored under another APP_SECRET. Recovery codes do not depend on it, so they still let the person in.
    console.warn(`[2fa] the authenticator secret of account ${vendor.id} cannot be read (was APP_SECRET changed?); only recovery codes work`);
  }
  if (step !== null) {
    const { rowCount } = await q.query(`UPDATE vendors SET totp_last_step = $2 WHERE id = $1 AND COALESCE(totp_last_step, 0) < $2`, [vendor.id, step]);
    return rowCount > 0;
  }
  const { rowCount } = await q.query(
    `UPDATE vendors SET recovery_hashes = array_remove(recovery_hashes, $2::text) WHERE id = $1 AND $2::text = ANY(recovery_hashes)`,
    [vendor.id, hashRecoveryCode(code)],
  );
  return rowCount > 0;
}

const CODE_TRIES = 10;
const CODE_WINDOW_MS = 15 * 60_000;

/**
 * useSecondStep with a limit on wrong codes for the whole account, from wherever they come. For callers who have checked the
 * password first, so that outsiders cannot use the tries up.
 */
export async function useCode(db, { guards, vendor, code }) {
  const key = `otp:${vendor.id}`;
  if (guards && (await hit(db, key, CODE_WINDOW_MS)).hits > CODE_TRIES) {
    throw new HttpError(429, 'ACCOUNT_LOCKED', 'Too many wrong codes. Wait 15 minutes and try again.');
  }
  const right = await useSecondStep(db, vendor, code);
  if (right && guards) await forget(db, key);
  return right;
}

const wrongCode = () => new HttpError(400, 'OTP_WRONG', 'That code is not right. Use the newest code from your app.');

export function twoFactorRouter(db, { accountLimiter, guards }) {
  const router = Router();

  router.use((req, _res, next) => next(req.staffId ? forbidden('The kitchen login does not use two-step sign-in.') : undefined));

  const mine = async (req) => (await db.query(`SELECT * FROM vendors WHERE id = $1`, [req.vendorId])).rows[0];
  const checkPassword = async (vendor, session, password) => {
    if (!(await checkOwnPassword(db, { guards, vendor, session, password }))) throw new HttpError(400, 'WRONG_PASSWORD', 'Your password is not right.');
  };

  router.get('/', async (req, res) => {
    const vendor = await mine(req);
    res.json({ data: { enabled: Boolean(vendor.totp_enabled_at), recovery_codes_left: vendor.totp_enabled_at ? vendor.recovery_hashes.length : 0 } });
  });

  // Step 1: a new secret, as a QR code for the app. Nothing changes at sign-in until a code from it has been typed back.
  router.post('/setup', accountLimiter, async (req, res) => {
    const { password } = parse(passwordSchema, req.body ?? {});
    const vendor = await mine(req);
    await checkPassword(vendor, req.sessionKey, password);
    if (vendor.totp_enabled_at) throw conflict('ALREADY_ENABLED', 'Two-step sign-in is already on.');
    const secret = newTotpSecret();
    await db.query(`UPDATE vendors SET totp_secret_enc = $2, totp_last_step = NULL WHERE id = $1`, [vendor.id, encryptSecret(secret)]);
    const url = otpauthUrl(secret, vendor.email);
    res.json({ data: { secret, otpauth_url: url, qr: await QRCode.toDataURL(url, { width: 240, margin: 1 }) } });
  });

  // Step 2: the app shows the right code, so switch it on and hand out the recovery codes (this once).
  router.post('/enable', accountLimiter, async (req, res) => {
    const { code } = parse(codeSchema, req.body ?? {});
    const vendor = await mine(req);
    if (vendor.totp_enabled_at) throw conflict('ALREADY_ENABLED', 'Two-step sign-in is already on.');
    if (!vendor.totp_secret_enc) throw conflict('SETUP_FIRST', 'Start the set-up again.');
    const step = verifyTotp(decryptSecret(vendor.totp_secret_enc), code);
    if (step === null) throw wrongCode();
    const codes = newRecoveryCodes();
    await db.tx(async (t) => {
      await t.query(`UPDATE vendors SET totp_enabled_at = now(), totp_last_step = $2, recovery_hashes = $3 WHERE id = $1`, [vendor.id, step, codes.map(hashRecoveryCode)]);
      await record(t, 'auth.two_step_on', { vendorId: vendor.id, actor: vendor.email });
    });
    res.json({ data: { enabled: true, recovery_codes: codes } });
  });

  router.post('/disable', accountLimiter, async (req, res) => {
    const body = parse(disableSchema, req.body ?? {});
    const vendor = await mine(req);
    await checkPassword(vendor, req.sessionKey, body.password);
    if (!vendor.totp_enabled_at) throw conflict('NOT_ENABLED', 'Two-step sign-in is not on.');
    if (!(await useCode(db, { guards, vendor, code: body.code }))) throw wrongCode();
    await db.tx(async (t) => {
      await clearSecondStep(t, vendor.id);
      await record(t, 'auth.two_step_off', { vendorId: vendor.id, actor: vendor.email });
    });
    res.json({ data: { enabled: false } });
  });

  return router;
}

/** Switches two-step sign-in off for an account (the account itself, or the owner helping a restaurant that lost its phone). */
export const clearSecondStep = (q, vendorId) =>
  q.query(`UPDATE vendors SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, recovery_hashes = '{}' WHERE id = $1`, [vendorId]);

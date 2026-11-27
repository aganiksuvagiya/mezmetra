import express, { Router } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { record } from '../lib/audit.js';
import { forbidden, HttpError, notFound, parse, suspended, unauthorized } from '../lib/errors.js';
import { assertStrongPassword, checkOwnPassword, hashPassword, PUBLIC_PASSWORDS } from '../lib/passwords.js';
import { clientIp, forget, forgetAll, guardedTry } from '../lib/rateLimit.js';
import { passwordResetEmail } from '../lib/mailer.js';
import { vendorOut } from '../lib/serialize.js';
import { detectImageMime, IMAGE_TYPES } from '../lib/image.js';
import { requireActiveVendor, requireAuth, signToken } from '../middleware/auth.js';
import { twoFactorRouter, useCode } from './twoFactor.js';
import { STYLE_IDS } from '../../../shared/styles.js';

const email = z.string().trim().toLowerCase().max(200).pipe(z.email('Enter a valid email address'));

const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(200),
  // The code from the authenticator app (or a recovery code), for an account with two-step sign-in.
  otp: z.string().trim().max(20).optional(),
});

// Compared against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptCost);

// Failed tries for one account: from one address, and from everywhere together, within the window.
const LOCK_WINDOW_MS = 15 * 60_000;
const LOCK_AFTER_FROM_ONE_ADDRESS = 10;
const LOCK_AFTER_IN_ALL = 50;

const forgotSchema = z.object({ email });
const resetSchema = z.object({
  token: z.string().trim().min(20, 'This reset link is not valid').max(200),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Enter your current password').max(200),
  new_password: z.string().min(8, 'Use at least 8 characters').max(200),
});

// Only the hash of a reset token is stored.
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function authRouter(db, limits, mailer) {
  const { loginLimiter, accountLimiter, guards } = limits;
  const router = Router();

  // There is no public sign-up: a restaurant account is created by the platform owner (see routes/platform.js).

  router.post('/login', loginLimiter, async (req, res) => {
    const body = parse(loginSchema, req.body);
    // Every try counts against the account before the password is looked at; a right one takes its count back.
    const counted = guards
      ? await guardedTry(db, `signin:${body.email}`, req, { windowMs: LOCK_WINDOW_MS, perAddress: LOCK_AFTER_FROM_ONE_ADDRESS, inAll: LOCK_AFTER_IN_ALL })
      : null;
    if (counted?.locked) {
      await record(db, 'auth.locked', { actor: body.email, ip: clientIp(req) });
      throw new HttpError(429, 'ACCOUNT_LOCKED', 'Too many tries for this account. Wait 15 minutes, or use "Forgot password".');
    }
    const { rows } = await db.query(`SELECT * FROM vendors WHERE lower(email) = $1`, [body.email]);
    let vendor = rows[0];
    // Not a restaurant's own login? It may be a restaurant's kitchen login (see routes/kitchenLogin.js).
    let staff = null;
    if (!vendor) {
      staff = (await db.query(`SELECT * FROM vendor_staff WHERE lower(email) = $1`, [body.email])).rows[0] ?? null;
      if (staff) vendor = (await db.query(`SELECT * FROM vendors WHERE id = $1`, [staff.vendor_id])).rows[0];
    }
    const account = staff ?? vendor;
    // bcrypt reads a NUL byte as the end of a password and starts over, so "secret\0secret" would pass for "secret": never one.
    const ok = (await bcrypt.compare(body.password, account?.password_hash ?? DUMMY_HASH)) && !body.password.includes('\0');
    const failed = (reason) => record(db, 'auth.login_failed', { vendorId: vendor?.id ?? null, actor: body.email, ip: clientIp(req), detail: { reason } });
    if (!vendor || !ok) {
      await failed('password');
      throw unauthorized('Email or password is incorrect');
    }
    if (vendor.suspended_at) throw suspended(vendor.suspended_reason);
    if (config.refusePublicPasswords && PUBLIC_PASSWORDS.has(body.password)) {
      await failed('public_password');
      throw forbidden('This password is written in the program\'s public source code, so it cannot be used. Choose a new one with "Forgot password", or ask the platform owner.');
    }
    if (!staff && vendor.totp_enabled_at) {
      if (!body.otp) {
        await counted?.undo(); // the password was right
        throw new HttpError(400, 'OTP_REQUIRED', 'Enter the 6-digit code from your authenticator app.');
      }
      // Only someone with the password gets this far, so the codes have a hard limit of their own for the whole account.
      if (!(await useCode(db, { guards, vendor, code: body.otp }))) {
        await failed('code');
        throw new HttpError(400, 'OTP_WRONG', 'That code is not right. Use the newest code from your app, or a recovery code.');
      }
    }
    if (counted) {
      await counted.undo();
      await forget(db, counted.mine); // a successful sign-in clears the wrong tries from this address
    }
    // The password checked must still be the account's: one changed in the meantime gets no session, and stays changed. A hash made
    // with a lower work factor is replaced now that the password is known.
    const table = staff ? 'vendor_staff' : 'vendors';
    const still =
      bcrypt.getRounds(account.password_hash) < config.bcryptCost
        ? await db.query(`UPDATE ${table} SET password_hash = $2 WHERE id = $1 AND password_hash = $3 RETURNING id`, [account.id, await hashPassword(body.password), account.password_hash])
        : await db.query(`SELECT id FROM ${table} WHERE id = $1 AND password_hash = $2`, [account.id, account.password_hash]);
    if (!still.rows[0]) throw unauthorized('Email or password is incorrect');
    res.json({ data: { token: signToken(vendor.id, staff ? { staffId: staff.id } : undefined), vendor: vendorOut(vendor, staff) } });
  });

  // Ends this one session on the server: a copy of its token stops working too.
  router.post('/logout', requireAuth, async (req, res) => {
    if (req.tokenId) {
      await db.query(`INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, to_timestamp($2)) ON CONFLICT DO NOTHING`, [req.tokenId, req.tokenExpiresAt]);
    }
    res.json({ data: { ok: true } });
  });

  router.use('/2fa', requireAuth, requireActiveVendor(db), twoFactorRouter(db, limits));

  // Always answers the same way, so the form cannot be used to find out which emails have an account.
  router.post('/forgot-password', accountLimiter, async (req, res) => {
    const body = parse(forgotSchema, req.body);
    const { rows } = await db.query(`SELECT id, name, email, suspended_at FROM vendors WHERE lower(email) = $1`, [body.email]);
    const vendor = rows[0];
    if (vendor && !vendor.suspended_at) {
      // At most one email a minute per account.
      const recent = await db.query(`SELECT 1 FROM password_resets WHERE vendor_id = $1 AND created_at > now() - interval '60 seconds'`, [vendor.id]);
      if (recent.rowCount === 0) {
        const token = randomBytes(32).toString('base64url');
        await db.tx(async (t) => {
          await t.query(`DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'`);
          await t.query(`UPDATE password_resets SET used_at = now() WHERE vendor_id = $1 AND used_at IS NULL`, [vendor.id]);
          await t.query(`INSERT INTO password_resets (vendor_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3::int))`, [
            vendor.id,
            hashToken(token),
            config.passwordResetMinutes,
          ]);
        });
        // After '#', which browsers never send to a server: the token stays out of the web host's logs.
        const link = `${config.adminAppUrl}/reset-password#token=${token}`;
        // Not awaited: the reply must not depend on (or reveal) whether an email went out.
        Promise.resolve(mailer.send(passwordResetEmail({ to: vendor.email, name: vendor.name, link, minutes: config.passwordResetMinutes }))).catch((err) =>
          console.error('[mail] could not send the password reset email:', err.message),
        );
      }
    }
    res.json({ data: { ok: true } });
  });

  router.post('/reset-password', accountLimiter, async (req, res) => {
    const body = parse(resetSchema, req.body);
    assertStrongPassword(body.password);
    const hash = await hashPassword(body.password);
    const vendorId = await db.tx(async (t) => {
      const { rows } = await t.query(
        `SELECT id, vendor_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [hashToken(body.token)],
      );
      const reset = rows[0];
      if (!reset) throw new HttpError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired. Please request a new one.');
      await record(t, 'auth.password_reset', { vendorId: reset.vendor_id, ip: clientIp(req) });
      await t.query(`UPDATE vendors SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [reset.vendor_id, hash]);
      await t.query(`UPDATE password_resets SET used_at = now() WHERE vendor_id = $1 AND used_at IS NULL`, [reset.vendor_id]);
      return reset.vendor_id;
    });
    // "Forgot password" is the way back into a locked account.
    const { rows } = await db.query(`SELECT lower(email) AS email FROM vendors WHERE id = $1`, [vendorId]);
    if (rows[0]) await forgetAll(db, `signin:${rows[0].email}`);
    await forgetAll(db, `otp:${vendorId}`);
    res.json({ data: { ok: true } });
  });

  router.get('/me', requireAuth, requireActiveVendor(db), async (req, res) => {
    const { rows } = await db.query(`SELECT * FROM vendors WHERE id = $1`, [req.vendorId]);
    if (!rows[0]) throw unauthorized('Account no longer exists');
    const staff = req.staffId ? (await db.query(`SELECT email FROM vendor_staff WHERE id = $1`, [req.staffId])).rows[0] : null;
    res.json({ data: vendorOut(rows[0], staff) });
  });

  // A signed-in restaurant changes its own password. Every older session is signed out by the change, so the answer carries a fresh token.
  router.post('/change-password', accountLimiter, requireAuth, requireActiveVendor(db), async (req, res) => {
    // A kitchen login never changes the restaurant's password (the restaurant sets the kitchen's from its Settings).
    if (req.staffId) throw forbidden('The kitchen login cannot change passwords.');
    const body = parse(changePasswordSchema, req.body);
    const { rows } = await db.query(`SELECT * FROM vendors WHERE id = $1`, [req.vendorId]);
    const vendor = rows[0];
    if (!vendor) throw unauthorized('Account no longer exists');
    // Not a 401: the session itself is fine, and a 401 would sign the person out of the admin.
    if (!(await checkOwnPassword(db, { guards, vendor, session: req.sessionKey, password: body.current_password }))) {
      throw new HttpError(400, 'WRONG_PASSWORD', 'Your current password is not right.');
    }
    if (body.new_password === body.current_password) {
      throw new HttpError(400, 'SAME_PASSWORD', 'Choose a password that is different from your current one.');
    }
    assertStrongPassword(body.new_password, 'new_password', { email: vendor.email });
    const hash = await hashPassword(body.new_password);
    // This server's clock on both sides (not the database's), so the token signed below can never look older than the change.
    const changedAt = new Date();
    const updated = await db.tx(async (t) => {
      const r = await t.query(`UPDATE vendors SET password_hash = $2, password_changed_at = $3 WHERE id = $1 RETURNING *`, [vendor.id, hash, changedAt]);
      await t.query(`UPDATE password_resets SET used_at = now() WHERE vendor_id = $1 AND used_at IS NULL`, [vendor.id]);
      await record(t, 'auth.password_changed', { vendorId: vendor.id, actor: vendor.email, ip: clientIp(req) });
      return r.rows[0];
    });
    res.json({ data: { token: signToken(updated.id), vendor: vendorOut(updated) } });
  });

  return router;
}

const hexColour = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #2f6f62')
  .transform((s) => s.toLowerCase());

const vendorPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    tax_percent: z.number().min(0).max(100),
    timezone: z.string().trim().min(1).max(64),
    theme_primary: hexColour,
    theme_accent: hexColour,
    theme_style: z.enum(STYLE_IDS),
    table_code_mode: z.enum(['off', 'optional', 'required']),
  })
  .partial();

const MAX_LOGO_BYTES = 512 * 1024;

export function vendorRouter(db) {
  const router = Router();

  router.get('/', async (req, res) => {
    const { rows } = await db.query(`SELECT * FROM vendors WHERE id = $1`, [req.vendorId]);
    if (!rows[0]) throw notFound('Vendor');
    res.json({ data: vendorOut(rows[0]) });
  });

  router.patch('/', async (req, res) => {
    const body = parse(vendorPatchSchema, req.body);
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: body.timezone });
      } catch {
        throw new HttpError(400, 'VALIDATION_ERROR', 'timezone: Unknown time zone');
      }
    }
    const { rows } = await db.query(
      `UPDATE vendors SET
         name          = COALESCE($2, name),
         tax_percent   = COALESCE($3, tax_percent),
         timezone      = COALESCE($4, timezone),
         theme_primary = COALESCE($5, theme_primary),
         theme_accent  = COALESCE($6, theme_accent),
         table_code_mode = COALESCE($7, table_code_mode),
         theme_style   = COALESCE($8, theme_style)
       WHERE id = $1 RETURNING *`,
      [req.vendorId, body.name ?? null, body.tax_percent ?? null, body.timezone ?? null, body.theme_primary ?? null, body.theme_accent ?? null, body.table_code_mode ?? null, body.theme_style ?? null],
    );
    res.json({ data: vendorOut(rows[0]) });
  });

  // Logo upload: send the raw image bytes as the body with Content-Type image/jpeg|png|webp (the admin shrinks it first).
  router.put('/logo', express.raw({ type: IMAGE_TYPES, limit: MAX_LOGO_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'Send a JPEG, PNG or WebP image as the request body');
    }
    const mime = detectImageMime(req.body);
    if (!mime) throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'File is not a valid JPEG, PNG or WebP image');
    const vendor = await db.tx(async (t) => {
      await t.query(
        `INSERT INTO vendor_logos (vendor_id, mime, data) VALUES ($1, $2, $3)
         ON CONFLICT (vendor_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`,
        [req.vendorId, mime, req.body],
      );
      const { rows } = await t.query(`UPDATE vendors SET has_logo = true, logo_version = logo_version + 1 WHERE id = $1 RETURNING *`, [req.vendorId]);
      return rows[0];
    });
    res.json({ data: vendorOut(vendor) });
  });

  router.delete('/logo', async (req, res) => {
    const vendor = await db.tx(async (t) => {
      await t.query(`DELETE FROM vendor_logos WHERE vendor_id = $1`, [req.vendorId]);
      const { rows } = await t.query(`UPDATE vendors SET has_logo = false, logo_version = logo_version + 1 WHERE id = $1 RETURNING *`, [req.vendorId]);
      return rows[0];
    });
    res.json({ data: vendorOut(vendor) });
  });

  return router;
}

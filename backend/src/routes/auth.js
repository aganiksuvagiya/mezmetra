import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError, notFound, parse, suspended, unauthorized } from '../lib/errors.js';
import { passwordResetEmail } from '../lib/mailer.js';
import { vendorOut } from '../lib/serialize.js';
import { requireActiveVendor, requireAuth, signToken } from '../middleware/auth.js';

const email = z.string().trim().toLowerCase().max(200).pipe(z.email('Enter a valid email address'));

const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your restaurant name').max(100),
  email,
  password: z.string().min(8, 'Use at least 8 characters').max(200),
});

const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(200),
});

// Compared against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const forgotSchema = z.object({ email });
const resetSchema = z.object({
  token: z.string().trim().min(20, 'This reset link is not valid').max(200),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
});

// Only the hash of a reset token is stored.
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function authRouter(db, { loginLimiter }, mailer) {
  const router = Router();

  router.post('/signup', loginLimiter, async (req, res) => {
    if (!config.allowSignup) throw new HttpError(403, 'SIGNUP_DISABLED', 'Sign up is disabled');
    const body = parse(signupSchema, req.body);
    const hash = await bcrypt.hash(body.password, 10);
    const vendor = await db.tx(async (t) => {
      const { rows } = await t.query(
        `INSERT INTO vendors (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
        [body.name, body.email, hash],
      );
      await t.query(`INSERT INTO vendor_payment_settings (vendor_id) VALUES ($1)`, [rows[0].id]);
      return rows[0];
    });
    res.status(201).json({ data: { token: signToken(vendor.id), vendor: vendorOut(vendor) } });
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const body = parse(loginSchema, req.body);
    const { rows } = await db.query(`SELECT * FROM vendors WHERE lower(email) = $1`, [body.email]);
    const vendor = rows[0];
    const ok = await bcrypt.compare(body.password, vendor?.password_hash ?? DUMMY_HASH);
    if (!vendor || !ok) throw unauthorized('Email or password is incorrect');
    if (vendor.suspended_at) throw suspended(vendor.suspended_reason);
    res.json({ data: { token: signToken(vendor.id), vendor: vendorOut(vendor) } });
  });

  // Always answers the same way, so the form cannot be used to find out which emails have an account.
  router.post('/forgot-password', loginLimiter, async (req, res) => {
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
        const link = `${config.adminAppUrl}/reset-password?token=${token}`;
        // Not awaited: the reply must not depend on (or reveal) whether an email went out.
        Promise.resolve(mailer.send(passwordResetEmail({ to: vendor.email, name: vendor.name, link, minutes: config.passwordResetMinutes }))).catch((err) =>
          console.error('[mail] could not send the password reset email:', err.message),
        );
      }
    }
    res.json({ data: { ok: true } });
  });

  router.post('/reset-password', loginLimiter, async (req, res) => {
    const body = parse(resetSchema, req.body);
    const hash = await bcrypt.hash(body.password, 10);
    await db.tx(async (t) => {
      const { rows } = await t.query(
        `SELECT id, vendor_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [hashToken(body.token)],
      );
      const reset = rows[0];
      if (!reset) throw new HttpError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired. Please request a new one.');
      await t.query(`UPDATE vendors SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [reset.vendor_id, hash]);
      await t.query(`UPDATE password_resets SET used_at = now() WHERE vendor_id = $1 AND used_at IS NULL`, [reset.vendor_id]);
    });
    res.json({ data: { ok: true } });
  });

  router.get('/me', requireAuth, requireActiveVendor(db), async (req, res) => {
    const { rows } = await db.query(`SELECT * FROM vendors WHERE id = $1`, [req.vendorId]);
    if (!rows[0]) throw unauthorized('Account no longer exists');
    res.json({ data: vendorOut(rows[0]) });
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
  })
  .partial();

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
         theme_accent  = COALESCE($6, theme_accent)
       WHERE id = $1 RETURNING *`,
      [req.vendorId, body.name ?? null, body.tax_percent ?? null, body.timezone ?? null, body.theme_primary ?? null, body.theme_accent ?? null],
    );
    res.json({ data: vendorOut(rows[0]) });
  });

  return router;
}

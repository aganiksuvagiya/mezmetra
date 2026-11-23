import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { emailField, emailInUse } from '../lib/accounts.js';
import { conflict, notFound, parse } from '../lib/errors.js';
import { isSuperAdminEmail } from '../lib/serialize.js';

// The restaurant's kitchen login: an email and a password of its own that open the kitchen screen and nothing else (the API enforces that, see
// kitchenGuard). The restaurant sets it, changes its password and removes it here. Mounted under /api/admin, so a kitchen login cannot use it.

const putSchema = z.object({
  email: emailField,
  // Needed when there is no kitchen login yet; when there is one, leave it out to keep the password and only change the email.
  password: z.string().min(8, 'Use at least 8 characters').max(200).optional(),
});

const out = (s) => ({ configured: Boolean(s), email: s?.email ?? null, created_at: s?.created_at ?? null });

export function kitchenLoginRouter(db) {
  const router = Router();

  router.get('/', async (req, res) => {
    const { rows } = await db.query(`SELECT email, created_at FROM vendor_staff WHERE vendor_id = $1`, [req.vendorId]);
    res.json({ data: out(rows[0]) });
  });

  router.put('/', async (req, res) => {
    const body = parse(putSchema, req.body ?? {});
    const result = await db.tx(async (t) => {
      const existing = (await t.query(`SELECT id FROM vendor_staff WHERE vendor_id = $1 FOR UPDATE`, [req.vendorId])).rows[0];
      if (!existing && !body.password) throw conflict('PASSWORD_REQUIRED', 'Choose a password for the kitchen login.');
      // One address is one login: not a restaurant's own, not another kitchen's, and never an address reserved for a platform owner.
      if (isSuperAdminEmail(body.email)) throw conflict('RESERVED_EMAIL', 'That email is reserved. Use another one for the kitchen.');
      if (await emailInUse(t, body.email, { staffVendorId: req.vendorId })) throw conflict('EMAIL_TAKEN', 'That email is already used by another login. Use a different one for the kitchen.');
      const hash = body.password ? await bcrypt.hash(body.password, 10) : null;
      if (existing) {
        // A new password signs the kitchen out everywhere (this server's clock on both sides, as for the restaurant's own).
        await t.query(
          `UPDATE vendor_staff SET email = $2, password_hash = COALESCE($3, password_hash), password_changed_at = CASE WHEN $3::text IS NULL THEN password_changed_at ELSE $4 END WHERE id = $1`,
          [existing.id, body.email, hash, new Date()],
        );
      } else {
        await t.query(`INSERT INTO vendor_staff (vendor_id, email, password_hash) VALUES ($1, $2, $3)`, [req.vendorId, body.email, hash]);
      }
      return (await t.query(`SELECT email, created_at FROM vendor_staff WHERE vendor_id = $1`, [req.vendorId])).rows[0];
    });
    res.json({ data: out(result) });
  });

  router.delete('/', async (req, res) => {
    const gone = await db.query(`DELETE FROM vendor_staff WHERE vendor_id = $1`, [req.vendorId]);
    if (gone.rowCount === 0) throw notFound('Kitchen login');
    res.json({ data: out(null) });
  });

  return router;
}

import bcrypt from 'bcryptjs';
import { z } from 'zod';

// A restaurant account is created in one place only: this function. Nobody signs themselves up; the platform owner creates the account
// (owner console, or `npm run create-restaurant` on a fresh database) and hands the login over.

export const emailField = z.string().trim().toLowerCase().max(200).pipe(z.email('Enter a valid email address'));

export const newRestaurantSchema = z.object({
  name: z.string().trim().min(2, 'Enter the restaurant name').max(100),
  email: emailField,
  password: z.string().min(8, 'Use at least 8 characters').max(200),
});

/**
 * Is this email already somebody's login: a restaurant's own, or a restaurant's kitchen login? One address opens exactly one login.
 * `vendorId`: leave that restaurant's own row out (when it changes its own email). `staffVendorId`: leave that restaurant's kitchen login out.
 */
export async function emailInUse(q, email, { vendorId = null, staffVendorId = null } = {}) {
  const { rowCount } = await q.query(
    `SELECT 1 FROM vendors WHERE lower(email) = $1 AND ($2::bigint IS NULL OR id <> $2::bigint)
     UNION ALL
     SELECT 1 FROM vendor_staff WHERE lower(email) = $1 AND ($3::bigint IS NULL OR vendor_id <> $3::bigint)`,
    [email.trim().toLowerCase(), vendorId, staffVendorId],
  );
  return rowCount > 0;
}

/** Insert the restaurant and its (empty) payment settings. `q` is the database or a transaction. Returns the new vendor row. */
export async function createRestaurantAccount(q, { name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await q.query(`INSERT INTO vendors (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *`, [name.trim(), email.trim().toLowerCase(), hash]);
  await q.query(`INSERT INTO vendor_payment_settings (vendor_id) VALUES ($1)`, [rows[0].id]);
  return rows[0];
}

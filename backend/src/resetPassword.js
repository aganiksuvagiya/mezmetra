import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { createDb } from './db.js';

// `NEW_PASSWORD='...' npm run reset-password -w backend -- someone@example.com`
//
// Sets a new password for one restaurant account on whatever database backend/.env points to (DATABASE_URL, e.g. Aiven;
// empty = the local PGlite database). Passwords are stored as one-way bcrypt hashes, so an old password can never be read
// back; this is the way to get back into an account when "Forgot password" email is not set up.
// The new password comes from the NEW_PASSWORD environment variable so it never ends up in the command's arguments or in git.

const email = (process.argv[2] ?? '').trim();
const password = process.env.NEW_PASSWORD ?? '';

const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

if (!email) fail("Which account? Usage:\n  NEW_PASSWORD='a-new-password' npm run reset-password -w backend -- you@example.com");
if (password.length < 8) fail('NEW_PASSWORD is missing or shorter than 8 characters (the same rule as signup).');
if (password.length > 200) fail('NEW_PASSWORD is longer than 200 characters.');

const target = config.databaseUrl ? new URL(config.databaseUrl).host : `the local PGlite database (${config.pgliteDir})`;
console.log(`Database: ${target}`);

const db = await createDb().catch((err) => fail(`Could not connect to the database: ${err.message}`));

try {
  const found = await db.query(`SELECT id, name, email FROM vendors WHERE lower(email) = lower($1)`, [email]);
  if (found.rowCount === 0) {
    const known = await db.query(`SELECT email FROM vendors ORDER BY id LIMIT 20`);
    fail(
      `No account with the email "${email}" in this database.\n` +
        (known.rowCount ? `Accounts here: ${known.rows.map((r) => r.email).join(', ')}` : 'There are no accounts in this database yet.'),
    );
  }
  const vendor = found.rows[0];
  const hash = await bcrypt.hash(password, 10);
  await db.tx(async (t) => {
    // password_changed_at makes every login token issued before now stop working, like the "Forgot password" flow does.
    await t.query(`UPDATE vendors SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [vendor.id, hash]);
    await t.query(`UPDATE password_resets SET used_at = now() WHERE vendor_id = $1 AND used_at IS NULL`, [vendor.id]);
  });
  console.log(`Done. "${vendor.name}" (${vendor.email}) can now sign in with the new password.`);
} finally {
  await db.close();
}

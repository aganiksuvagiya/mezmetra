import { config } from './config.js';
import { createDb } from './db.js';
import { createRestaurantAccount, emailInUse, newRestaurantSchema } from './lib/accounts.js';

// `NEW_PASSWORD='...' npm run create-restaurant -w backend -- "Restaurant name" owner@example.com`
//
// Creates one restaurant account on whatever database backend/.env points to (DATABASE_URL, e.g. Aiven; empty = the local PGlite database).
// Restaurants are normally added by the platform owner from the owner console; this is for the very first account of a fresh database,
// when nobody can sign in yet. The password comes from the NEW_PASSWORD environment variable so it never ends up in the command or in git.

const [name = '', email = ''] = process.argv.slice(2);
const password = process.env.NEW_PASSWORD ?? '';

const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

const parsed = newRestaurantSchema.safeParse({ name, email, password });
if (!parsed.success) {
  fail(
    `${parsed.error.issues.map((i) => `- ${i.path[0] === 'password' ? 'NEW_PASSWORD' : i.path[0]}: ${i.message}`).join('\n')}\n\n` +
      "Usage:\n  NEW_PASSWORD='a-long-password' npm run create-restaurant -w backend -- \"Restaurant name\" owner@example.com",
  );
}

const target = config.databaseUrl ? new URL(config.databaseUrl).host : `the local PGlite database (${config.pgliteDir})`;
console.log(`Database: ${target}`);

const db = await createDb().catch((err) => fail(`Could not connect to the database: ${err.message}`));

try {
  if (await emailInUse(db, parsed.data.email)) fail(`A restaurant with the email "${parsed.data.email}" already exists in this database.`);
  const vendor = await db.tx((t) => createRestaurantAccount(t, parsed.data));
  console.log(`Done. "${vendor.name}" (${vendor.email}) can now sign in with the password you gave.`);
} finally {
  await db.close();
}

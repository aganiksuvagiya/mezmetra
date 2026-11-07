import { config } from './config.js';
import { createDb } from './db.js';

// `npm run db:check` - verifies DATABASE_URL (e.g. your Aiven service) before you start the app.
if (!config.databaseUrl) {
  console.log('DATABASE_URL is empty, so the API would use the local PGlite database (.data/pglite).');
  console.log('To check Aiven, set DATABASE_URL in backend/.env first (see backend/.env.example).');
  process.exit(0);
}

const host = new URL(config.databaseUrl).host;
console.log(`Connecting to ${host} ...`);
const db = await createDb().catch((err) => {
  console.error(`\nCould not connect: ${err.message}`);
  console.error('Check the URI, the password, that the service is running, and that your IP is allowed (Aiven: Allowed IP addresses).');
  process.exit(1);
});

try {
  const info = await db.query(
    `SELECT current_database() AS database, current_user AS "user", version() AS version,
            (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls`,
  );
  const { database, user, version, tls } = info.rows[0];
  console.log(`Connected as ${user} to database "${database}"`);
  console.log(version);
  console.log(`TLS: ${tls ? 'on' : 'OFF (unexpected for a managed database)'}`);
  const migrated = await db.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS has`);
  console.log(migrated.rows[0].has ? 'Schema: migrations table found (run `npm run db:migrate` to apply new ones).' : 'Schema: empty - run `npm run db:migrate`.');
} finally {
  await db.close();
}

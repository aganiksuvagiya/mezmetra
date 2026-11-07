import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(db, { log = console.log } = {}) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let applied = 0;
  for (const file of files) {
    await db.tx(async (t) => {
      // Serialise concurrent migrators (e.g. two app instances booting at once).
      await t.query('SELECT pg_advisory_xact_lock(727274)');
      const done = await t.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount > 0) return;
      await t.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
      await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied += 1;
      log(`[migrate] applied ${file}`);
    });
  }
  if (applied === 0) log('[migrate] database is up to date');
  return applied;
}

// `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await createDb();
  try {
    await migrate(db);
  } finally {
    await db.close();
  }
}

import { config } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { createApp } from './app.js';
import { seed } from './seed.js';

const db = await createDb();
if (config.autoMigrate) await migrate(db);
// Local convenience: the file-based dev database can only be opened by one process at a time, so the demo
// data is seeded from inside the running server instead of from a second `npm run db:seed` process.
if (process.env.SEED_DEMO === 'true') await seed(db);

const app = createApp({ db });
const server = app.listen(config.port, () => {
  console.log(`[mezmitra] API listening on http://localhost:${config.port} (database: ${db.kind})`);
  if (db.kind === 'pglite') {
    console.log('[mezmitra] No DATABASE_URL set - using the local PGlite database in', config.pgliteDir);
  }
});

async function shutdown(signal) {
  console.log(`[mezmitra] ${signal} received, shutting down`);
  server.close(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

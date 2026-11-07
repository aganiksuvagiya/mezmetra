import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { config } from './config.js';

// bigint ids/sums stay far below 2^53 here, so hand them to the app as plain numbers
// (node-postgres returns int8 as strings by default; PGlite already returns numbers).
pg.types.setTypeParser(20, (value) => Number(value));

/**
 * Both backends expose the same tiny interface:
 *   query(text, params) -> { rows, rowCount }
 *   exec(sql)           -> run a multi-statement script (no params)
 *   tx(fn)              -> fn receives an object with query()/exec() bound to one transaction
 *   close()
 * Inside tx(fn) only use the object you were given, never the outer db.
 */

function normalize(result) {
  const rows = result.rows ?? [];
  return { rows, rowCount: result.rowCount ?? result.affectedRows ?? rows.length };
}

async function createPglite(dir) {
  const inMemory = !dir || dir === 'memory' || dir === 'memory://';
  if (!inMemory) fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
  const db = new PGlite(inMemory ? undefined : dir);
  await db.waitReady;
  return {
    kind: 'pglite',
    query: async (text, params = []) => normalize(await db.query(text, params)),
    exec: async (sql) => {
      await db.exec(sql);
    },
    tx: (fn) =>
      db.transaction((t) =>
        fn({
          query: async (text, params = []) => normalize(await t.query(text, params)),
          exec: async (sql) => {
            await t.exec(sql);
          },
        }),
      ),
    close: () => db.close(),
  };
}

function loadCa() {
  if (config.databaseCa) return config.databaseCa.replace(/\\n/g, '\n');
  if (config.databaseCaPath) return fs.readFileSync(config.databaseCaPath, 'utf8');
  return '';
}

let warnedUnverifiedTls = false;

// Aiven (and most managed Postgres) require TLS. We take the TLS settings from env instead of the
// connection string's sslmode, so the behaviour is explicit and not subject to driver defaults.
function buildPgConfig(connectionString) {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  const host = url.hostname;
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(host);

  let ssl = false;
  const ca = loadCa();
  if (ca) {
    ssl = { ca, rejectUnauthorized: true };
  } else if (sslmode !== 'disable' && !isLocal) {
    ssl = { rejectUnauthorized: false };
    if (!warnedUnverifiedTls) {
      warnedUnverifiedTls = true;
      console.warn(
        '[db] TLS is on but the server certificate is NOT verified. Set DATABASE_CA_CERT_PATH to the ' +
          "provider's CA certificate (Aiven: Service overview -> CA certificate) to verify it.",
      );
    }
  }
  return { connectionString: url.toString(), ssl, max: config.poolMax, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 };
}

async function createPg(connectionString) {
  const pool = new pg.Pool(buildPgConfig(connectionString));
  pool.on('error', (err) => console.error('[db] idle client error', err.message));
  // Fail fast at boot when the URL/credentials are wrong.
  await pool.query('SELECT 1');
  return {
    kind: 'pg',
    query: async (text, params = []) => normalize(await pool.query(text, params)),
    exec: async (sql) => {
      await pool.query(sql);
    },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async (text, params = []) => normalize(await client.query(text, params)),
          exec: async (sql) => {
            await client.query(sql);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function createDb(options = {}) {
  const url = options.databaseUrl ?? config.databaseUrl;
  if (!url) return createPglite(options.pgliteDir ?? config.pgliteDir);
  return createPg(url);
}

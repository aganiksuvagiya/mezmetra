const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Stops a run on someone's own computer from working on a remote (very likely live) database by accident: backend/.env may hold the
 * live address. The server itself runs with NODE_ENV=production and is not affected. ALLOW_REMOTE_DB=true says it is meant.
 */
export function refuseRemoteDatabase(config, env = process.env) {
  if (!config.databaseUrl || config.isProd || env.ALLOW_REMOTE_DB === 'true') return;
  const host = new URL(config.databaseUrl).hostname;
  if (LOCAL_HOSTS.has(host)) return;
  throw new Error(
    `This would work on the remote database at ${host}, and this is not the live server (NODE_ENV is not "production"). ` +
      'For local work leave DATABASE_URL empty. If you really mean that database, run it once with ALLOW_REMOTE_DB=true.',
  );
}

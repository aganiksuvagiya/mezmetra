import express, { Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { errorHandler, notFound } from './lib/errors.js';
import { createMailer } from './lib/mailer.js';
import { createLimits, noLimits } from './lib/rateLimit.js';
import { kitchenGuard, requireActiveVendor, requireAuth, requireSuperAdmin } from './middleware/auth.js';
import { authRouter, vendorRouter } from './routes/auth.js';
import { categoriesRouter } from './routes/categories.js';
import { itemsRouter } from './routes/items.js';
import { kitchenLoginRouter } from './routes/kitchenLogin.js';
import { tablesRouter } from './routes/tables.js';
import { ordersRouter } from './routes/orders.js';
import { dashboardRouter } from './routes/dashboard.js';
import { paymentSettingsRouter } from './routes/paymentSettings.js';
import { platformRouter } from './routes/platform.js';
import { publicRouter } from './routes/public.js';
import { webhooksRouter } from './routes/webhooks.js';
import { reportsRouter } from './routes/reports.js';
import { requestsRouter } from './routes/requests.js';

// How long a successful database check answers /api/health: the address is open to anyone, and must not turn into database load.
const HEALTH_CACHE_MS = 5000;

/** Says once, in production, how requests reach this server, so the rate limits' client address can be checked (no addresses logged). */
function describeNetworkOnce() {
  let done = false;
  return (req, _res, next) => {
    if (!done && config.isProd && req.path !== '/api/health') {
      done = true;
      const hops = String(req.get('x-forwarded-for') ?? '').split(',').filter((s) => s.trim()).length;
      const header = config.clientIpHeader;
      console.log(`[net] first request: X-Forwarded-For entries=${hops}, client address from ${header ? `${header} (${req.get(header) ? 'present' : 'MISSING'})` : 'req.ip'}`);
    }
    next();
  };
}

export function createApp({ db, rateLimits = true, mailer = createMailer() } = {}) {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(describeNetworkOnce());

  const limits = rateLimits ? createLimits(db) : noLimits;

  // Item photos are loaded by the customer app from another origin.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
      maxAge: 600,
    }),
  );
  // Gateways call these from their servers. The signature is computed over the exact bytes, so the body stays raw here.
  app.use('/api/webhooks', limits.webhookLimiter, express.raw({ type: () => true, limit: '200kb' }), webhooksRouter(db));
  app.use(express.json({ limit: '100kb' }));

  let healthyAt = 0;
  app.get('/api/health', async (_req, res) => {
    if (Date.now() - healthyAt > HEALTH_CACHE_MS) {
      await db.query('SELECT 1');
      healthyAt = Date.now();
    }
    res.json({ data: { status: 'ok', database: db.kind } });
  });

  app.use('/api/auth', authRouter(db, limits, mailer));

  const admin = Router();
  admin.use(requireAuth, requireActiveVendor(db), kitchenGuard);
  admin.use('/vendor', vendorRouter(db));
  admin.use('/categories', categoriesRouter(db));
  admin.use('/items', itemsRouter(db));
  admin.use('/tables', tablesRouter(db));
  admin.use('/orders', ordersRouter(db));
  admin.use('/dashboard', dashboardRouter(db));
  admin.use('/payment-settings', paymentSettingsRouter(db, { limits, mailer }));
  admin.use('/reports', reportsRouter(db));
  admin.use('/requests', requestsRouter(db));
  admin.use('/kitchen-login', kitchenLoginRouter(db, limits));
  app.use('/api/admin', admin);
  app.use('/api/platform', requireAuth, requireActiveVendor(db), requireSuperAdmin, platformRouter(db));

  app.use('/api/public', limits.publicLimiter, publicRouter(db, limits));

  app.use((_req, _res, next) => next(notFound('Endpoint')));
  app.use(errorHandler);
  return app;
}

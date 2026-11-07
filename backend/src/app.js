import express, { Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { errorHandler, notFound } from './lib/errors.js';
import { createMailer } from './lib/mailer.js';
import { requireActiveVendor, requireAuth, requireSuperAdmin } from './middleware/auth.js';
import { authRouter, vendorRouter } from './routes/auth.js';
import { categoriesRouter } from './routes/categories.js';
import { itemsRouter } from './routes/items.js';
import { tablesRouter } from './routes/tables.js';
import { ordersRouter } from './routes/orders.js';
import { dashboardRouter } from './routes/dashboard.js';
import { paymentSettingsRouter } from './routes/paymentSettings.js';
import { platformRouter } from './routes/platform.js';
import { publicRouter } from './routes/public.js';
import { reportsRouter } from './routes/reports.js';

const limiter = ({ windowMs, limit }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' } }),
  });

const passThrough = (_req, _res, next) => next();

export function createApp({ db, rateLimits = true, mailer = createMailer() } = {}) {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Item photos are loaded by the customer app from another origin.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  const limits = rateLimits
    ? {
        loginLimiter: limiter({ windowMs: 15 * 60_000, limit: 20 }),
        // Limits are per client IP, and a restaurant's diners usually share one Wi-Fi IP. Each open order
        // page polls every ~5s, so the read limit has to leave room for dozens of diners at once.
        orderLimiter: limiter({ windowMs: 60_000, limit: 60 }),
        publicLimiter: limiter({ windowMs: 60_000, limit: 900 }),
      }
    : { loginLimiter: passThrough, orderLimiter: passThrough, publicLimiter: passThrough };

  app.get('/api/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ data: { status: 'ok', database: db.kind } });
  });

  app.use('/api/auth', authRouter(db, limits, mailer));

  const admin = Router();
  admin.use(requireAuth, requireActiveVendor(db));
  admin.use('/vendor', vendorRouter(db));
  admin.use('/categories', categoriesRouter(db));
  admin.use('/items', itemsRouter(db));
  admin.use('/tables', tablesRouter(db));
  admin.use('/orders', ordersRouter(db));
  admin.use('/dashboard', dashboardRouter(db));
  admin.use('/payment-settings', paymentSettingsRouter(db));
  admin.use('/reports', reportsRouter(db));
  app.use('/api/admin', admin);
  app.use('/api/platform', requireAuth, requireActiveVendor(db), requireSuperAdmin, platformRouter(db));

  app.use('/api/public', limits.publicLimiter, publicRouter(db, limits));

  app.use((_req, _res, next) => next(notFound('Endpoint')));
  app.use(errorHandler);
  return app;
}

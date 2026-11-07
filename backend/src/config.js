import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

// How many reverse proxies sit in front of the API (platforms such as Render add exactly one). Always a count, never
// Express's `true`: that would believe any X-Forwarded-For header a client sends and let them dodge the per-IP rate limits.
function proxyHops(value, fallback) {
  if (value === undefined || value === '') return fallback ? 1 : false;
  if (/^\d+$/.test(value)) return Number(value);
  return bool(value, false) ? 1 : false;
}

// Which ways of paying the product offers at all. For now only UPI; set PAYMENT_METHODS=upi,cash,razorpay to bring the others
// back (each restaurant still chooses among them in Admin -> Payments).
const KNOWN_PAYMENT_METHODS = ['upi', 'cash', 'razorpay'];
function paymentMethods(value) {
  const list = (value || 'upi')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = list.filter((m) => !KNOWN_PAYMENT_METHODS.includes(m));
  if (unknown.length > 0 || list.length === 0) {
    throw new Error(`PAYMENT_METHODS must list some of: ${KNOWN_PAYMENT_METHODS.join(', ')} (got "${value}")`);
  }
  return new Set(list);
}

// Accounts (by email) that run the platform: they get the "Platform" section in the admin to see every restaurant and
// suspend or reactivate it. A comma separated list; empty means nobody has platform access.
const emailList = (value) =>
  new Set(
    (value || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

// In production the secret must be set explicitly. In development we generate a random one once and
// keep it in .data/app-secret (git-ignored), so logins and saved payment keys survive restarts
// without ever shipping a known default value.
function devSecret() {
  const file = path.resolve('.data/app-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    return secret;
  }
}

const appSecret = isProd ? required('APP_SECRET') : env.APP_SECRET || (env.NODE_ENV === 'test' ? randomBytes(32).toString('hex') : devSecret());
if (isProd && appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters');

export const config = {
  isProd,
  port: Number(env.PORT || 4000),
  // Empty DATABASE_URL = local PGlite database stored in PGLITE_DIR (or in memory when set to "memory").
  databaseUrl: env.DATABASE_URL || '',
  databaseCa: env.DATABASE_CA_CERT || '',
  databaseCaPath: env.DATABASE_CA_CERT_PATH || '',
  pgliteDir: env.PGLITE_DIR || '.data/pglite',
  poolMax: Number(env.DATABASE_POOL_MAX || 5),
  // Apply pending SQL migrations when the server boots (safe: guarded by an advisory lock).
  autoMigrate: bool(env.AUTO_MIGRATE, true),
  appSecret,
  jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
  allowSignup: bool(env.ALLOW_SIGNUP, true),
  // A Set (read at request time, so tests can switch it): 'upi' | 'cash' | 'razorpay'.
  paymentMethods: paymentMethods(env.PAYMENT_METHODS),
  // A Set of lower-case emails (read at request time, so tests can change it).
  superAdminEmails: emailList(env.SUPER_ADMIN_EMAILS),
  // Email (password reset). Without SMTP_URL no email is sent. Example: smtps://user:app-password@smtp.gmail.com:465
  smtpUrl: env.SMTP_URL || '',
  mailFrom: env.MAIL_FROM || 'MezMitra <no-reply@localhost>',
  // Where the admin web app lives: the base of the link in the password reset email.
  adminAppUrl: (env.ADMIN_APP_URL || 'http://localhost:5180').replace(/\/+$/, ''),
  passwordResetMinutes: Number(env.PASSWORD_RESET_MINUTES || 60),
  // Comma separated list of browser origins allowed to call the API.
  corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5180,http://localhost:5174')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Where the customer web app lives; this base URL is what gets encoded in table QR codes.
  customerAppUrl: (env.CUSTOMER_APP_URL || 'http://localhost:5174').replace(/\/+$/, ''),
  razorpayApiBase: env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1',
  trustProxy: proxyHops(env.TRUST_PROXY, isProd),
};

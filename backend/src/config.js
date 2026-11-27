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

// Which ways of paying the product offers at all: cash at the counter, Razorpay and PhonePe. Each restaurant still chooses among
// them in Admin -> Payments.
const KNOWN_PAYMENT_METHODS = ['cash', 'razorpay', 'phonepe'];
// Ways of paying that were removed from the product. A deployment that still lists one must keep starting: it is ignored, with a note.
const REMOVED_PAYMENT_METHODS = ['upi', 'cashfree', 'paytm'];
function paymentMethods(value) {
  const asked = (value || KNOWN_PAYMENT_METHODS.join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const dropped = asked.filter((m) => REMOVED_PAYMENT_METHODS.includes(m));
  const unknown = asked.filter((m) => !KNOWN_PAYMENT_METHODS.includes(m) && !REMOVED_PAYMENT_METHODS.includes(m));
  if (unknown.length > 0 || asked.length === 0) {
    throw new Error(`PAYMENT_METHODS must list some of: ${KNOWN_PAYMENT_METHODS.join(', ')} (got "${value}")`);
  }
  if (dropped.length > 0) console.warn(`[mezmitra] PAYMENT_METHODS: ${dropped.join(', ')} no longer exist and are ignored`);
  const list = asked.filter((m) => KNOWN_PAYMENT_METHODS.includes(m));
  // Only removed ones listed (the old default was "upi"): offer cash, so restaurants can go on taking orders.
  return new Set(list.length > 0 ? list : ['cash']);
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
  // The live server refuses a database it cannot verify. This is the emergency way around that, and is logged loudly.
  allowUnverifiedDbTls: bool(env.DATABASE_ALLOW_UNVERIFIED_TLS, false),
  pgliteDir: env.PGLITE_DIR || '.data/pglite',
  poolMax: Number(env.DATABASE_POOL_MAX || 5),
  // Apply pending SQL migrations when the server boots (safe: guarded by an advisory lock).
  autoMigrate: bool(env.AUTO_MIGRATE, true),
  appSecret,
  jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
  // Work factor of password hashes. Older hashes are upgraded at the next sign-in. (Tests use a cheap one.)
  bcryptCost: Number(env.BCRYPT_COST || (env.NODE_ENV === 'test' ? 4 : 12)),
  // How many orders of one table may wait, unaccepted and unpaid, before it is told to call the staff.
  maxOpenOrdersPerTable: Number(env.MAX_OPEN_ORDERS_PER_TABLE || 12),
  // On the live server the demo accounts' passwords, which are written in the public source code, do not sign anyone in.
  refusePublicPasswords: isProd,
  // A Set (read at request time, so tests can switch it): 'cash' | 'razorpay' | 'phonepe'.
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
  // The live server takes only Razorpay's live keys (rzp_live_...); a local or test run also accepts test keys.
  razorpayLiveOnly: isProd,
  // PhonePe PG. Empty = PhonePe's own live servers. Tests point it at a fake.
  phonepeApiBase: (env.PHONEPE_API_BASE || '').replace(/\/+$/, ''),
  // The public address of this API (the webhook addresses are built on it). Empty = taken from the incoming request.
  apiPublicUrl: (env.API_PUBLIC_URL || '').replace(/\/+$/, ''),
  trustProxy: proxyHops(env.TRUST_PROXY, isProd),
  // The header in which the proxy in front of the API names the visitor's address (Cloudflare, which fronts Render: cf-connecting-ip).
  // Empty = use req.ip. Set it only where no request can reach the API without passing that proxy.
  clientIpHeader: (env.CLIENT_IP_HEADER || '').trim().toLowerCase(),
};

import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { record } from '../lib/audit.js';
import { HttpError, conflict, parse } from '../lib/errors.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { GATEWAYS } from '../lib/gateways.js';
import { paymentKeysChangedEmail } from '../lib/mailer.js';
import { CLIENT_ID_RE, CLIENT_VERSION_RE, phonepeWebhookAuth, pingPhonepe } from '../lib/phonepe.js';
import { checkOwnPassword } from '../lib/passwords.js';
import { clientIp } from '../lib/rateLimit.js';
import { isUsableKeyId, pingRazorpay, razorpayReady } from '../lib/razorpay.js';

const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;

const putSchema = z.object({
  cash_enabled: z.boolean().optional(),
  razorpay_enabled: z.boolean().optional(),
  razorpay_key_id: z
    .string()
    .trim()
    .regex(KEY_ID, 'Key ID looks like rzp_test_xxxxxxxx or rzp_live_xxxxxxxx')
    .refine((id) => !id.startsWith('rzp_test_') || isUsableKeyId(id), 'Test keys do not work on the live site. Enter a Key ID that starts with rzp_live_.')
    .optional(),
  // Write-only: never returned by the API. Omit it to keep the saved secret.
  razorpay_key_secret: z.string().trim().min(8).max(100).optional(),
  phonepe_enabled: z.boolean().optional(),
  phonepe_client_id: z.string().trim().regex(CLIENT_ID_RE, 'Client ID is the code from the PhonePe Business dashboard (letters, numbers, - _ .)').optional(),
  phonepe_client_version: z.string().trim().regex(CLIENT_VERSION_RE, 'Client Version is a short value such as 1').optional(),
  // Write-only, like the Razorpay secret.
  phonepe_client_secret: z.string().trim().min(8).max(200).optional(),
  // Webhooks (the gateway tells us a payment succeeded): write-only secrets typed in the gateway's own dashboard.
  razorpay_webhook_secret: z.string().trim().min(8, 'Use at least 8 characters').max(100).optional(),
  phonepe_webhook_username: z.string().trim().min(4, 'Use at least 4 characters').max(80).optional(),
  phonepe_webhook_password: z.string().trim().min(8, 'Use at least 8 characters').max(100).optional(),
  // Needed to change any key or secret: whoever decides where the money goes must know the password, not just hold a session.
  current_password: z.string().min(1).max(200).optional(),
});

// The fields that decide which account receives the money, or who can say that money arrived. `saved` is the column holding the
// current value when it can be compared (secrets are write-only, so any value sent counts as a change).
const PROTECTED = [
  ['razorpay_key_id', 'razorpay_key_id'],
  ['razorpay_key_secret'],
  ['phonepe_client_id', 'phonepe_client_id'],
  ['phonepe_client_version', 'phonepe_client_version'],
  ['phonepe_client_secret'],
  ['razorpay_webhook_secret'],
  ['phonepe_webhook_username'],
  ['phonepe_webhook_password'],
];

const out = (s, apiBase = '') => ({
  // Ways of paying the product offers right now; the admin shows only these.
  methods_available: [...config.paymentMethods],
  cash_enabled: s.cash_enabled,
  razorpay_enabled: s.razorpay_enabled,
  razorpay_key_id: s.razorpay_key_id,
  razorpay_secret_set: Boolean(s.razorpay_key_secret_enc),
  razorpay_mode: s.razorpay_key_id?.startsWith('rzp_live_') ? 'live' : s.razorpay_key_id ? 'test' : null,
  razorpay_configured: razorpayReady(s),
  // True on the live server, which takes no Razorpay test keys.
  razorpay_live_only: config.razorpayLiveOnly,
  phonepe_enabled: s.phonepe_enabled,
  phonepe_client_id: s.phonepe_client_id,
  phonepe_client_version: s.phonepe_client_version,
  phonepe_secret_set: Boolean(s.phonepe_secret_enc),
  phonepe_configured: GATEWAYS.phonepe.configured(s),
  // Webhooks: the address to paste into the gateway's dashboard (private to this restaurant) and whether its secret is saved.
  webhook_url_razorpay: `${apiBase}/api/webhooks/razorpay/${s.webhook_key}`,
  webhook_url_phonepe: `${apiBase}/api/webhooks/phonepe/${s.webhook_key}`,
  razorpay_webhook_set: Boolean(s.razorpay_webhook_secret_enc),
  phonepe_webhook_set: Boolean(s.phonepe_webhook_auth_enc),
});

// Where the gateway can reach this server (the public address of the API).
const apiBaseOf = (req) => config.apiPublicUrl || `${req.protocol}://${req.get('host')}`;

async function loadSettings(q, vendorId) {
  await q.query(`INSERT INTO vendor_payment_settings (vendor_id) VALUES ($1) ON CONFLICT DO NOTHING`, [vendorId]);
  const { rows } = await q.query(`SELECT * FROM vendor_payment_settings WHERE vendor_id = $1`, [vendorId]);
  return rows[0];
}

export function paymentSettingsRouter(db, { limits, mailer }) {
  const router = Router();
  // Password tries on this form are limited like password changes.
  const limitPasswordTries = (req, res, next) => (req.body?.current_password ? limits.accountLimiter(req, res, next) : next());

  router.get('/', async (req, res) => {
    res.json({ data: out(await loadSettings(db, req.vendorId), apiBaseOf(req)) });
  });

  router.put('/', limitPasswordTries, async (req, res) => {
    const body = parse(putSchema, req.body);
    const before = await loadSettings(db, req.vendorId);
    const changed = PROTECTED.filter(([field, saved]) => body[field] !== undefined && (!saved || body[field] !== before[saved])).map(([field]) => field);
    let owner = null;
    if (changed.length > 0) {
      owner = (await db.query(`SELECT id, name, email, password_hash FROM vendors WHERE id = $1`, [req.vendorId])).rows[0];
      const refuse = (code, message) => {
        throw new HttpError(400, code, message, [{ field: 'current_password', message }]);
      };
      if (!body.current_password) refuse('PASSWORD_REQUIRED', 'Enter your password to change payment keys.');
      if (!(await checkOwnPassword(db, { guards: limits.guards, vendor: owner, session: req.sessionKey, password: body.current_password }))) refuse('WRONG_PASSWORD', 'Your password is not right.');
    }
    const saved = await db.tx(async (t) => {
      const current = await loadSettings(t, req.vendorId);
      const keyId = body.razorpay_key_id ?? current.razorpay_key_id;
      const secretEnc = body.razorpay_key_secret ? encryptSecret(body.razorpay_key_secret) : current.razorpay_key_secret_enc;
      const razorpayEnabled = body.razorpay_enabled ?? current.razorpay_enabled;
      const ppEnabled = body.phonepe_enabled ?? current.phonepe_enabled;
      const ppClientId = body.phonepe_client_id ?? current.phonepe_client_id;
      const ppVersion = body.phonepe_client_version ?? current.phonepe_client_version;
      const ppSecretEnc = body.phonepe_client_secret ? encryptSecret(body.phonepe_client_secret) : current.phonepe_secret_enc;
      const rzWebhookEnc = body.razorpay_webhook_secret ? encryptSecret(body.razorpay_webhook_secret) : current.razorpay_webhook_secret_enc;
      // PhonePe's username and password are only ever used as their hash, so only the hash is kept.
      if ((body.phonepe_webhook_username === undefined) !== (body.phonepe_webhook_password === undefined)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter both the webhook username and the webhook password.');
      }
      const ppWebhookEnc = body.phonepe_webhook_username
        ? encryptSecret(phonepeWebhookAuth(body.phonepe_webhook_username, body.phonepe_webhook_password))
        : current.phonepe_webhook_auth_enc;
      const cashEnabled = body.cash_enabled ?? current.cash_enabled;
      // Only ways of paying the product offers right now can be switched on (see PAYMENT_METHODS in the README).
      for (const [method, wanted, label] of [
        ['cash', body.cash_enabled, 'Cash payments'],
        ['razorpay', body.razorpay_enabled, 'Online payments'],
        ['phonepe', body.phonepe_enabled, 'Online payments'],
      ]) {
        if (wanted === true && !config.paymentMethods.has(method)) {
          throw new HttpError(400, 'VALIDATION_ERROR', `${label} aren't available right now.`);
        }
      }

      if (razorpayEnabled && !(keyId && secretEnc)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter both the Razorpay Key ID and Key Secret before turning online payments on');
      }
      if (razorpayEnabled && !isUsableKeyId(keyId)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'The saved Razorpay key is a test key. Enter your live Key ID and Key Secret before turning online payments on.');
      }
      if (ppEnabled && !(ppClientId && ppVersion && ppSecretEnc)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter the PhonePe Client ID, Client Version and Client Secret before turning online payments on');
      }
      // Diners get one "Pay online" button, so a restaurant uses one gateway at a time.
      if (razorpayEnabled && ppEnabled) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Choose one online payment gateway: Razorpay or PhonePe. Turn the other off first.');
      }
      const allowed = config.paymentMethods;
      const onlineOn = (allowed.has('razorpay') && razorpayEnabled) || (allowed.has('phonepe') && ppEnabled);
      if (!onlineOn && !(allowed.has('cash') && cashEnabled)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Keep at least one payment method turned on');
      }
      const { rows } = await t.query(
        `UPDATE vendor_payment_settings
            SET cash_enabled = $2, razorpay_enabled = $3, razorpay_key_id = $4, razorpay_key_secret_enc = $5,
                phonepe_enabled = $6, phonepe_client_id = $7, phonepe_client_version = $8, phonepe_secret_enc = $9,
                razorpay_webhook_secret_enc = $10, phonepe_webhook_auth_enc = $11, updated_at = now()
          WHERE vendor_id = $1 RETURNING *`,
        [req.vendorId, cashEnabled, razorpayEnabled, keyId, secretEnc, ppEnabled, ppClientId, ppVersion, ppSecretEnc, rzWebhookEnc, ppWebhookEnc],
      );
      // Which settings changed is put on record; their values never are.
      const switches = ['cash_enabled', 'razorpay_enabled', 'phonepe_enabled'].filter((f) => rows[0][f] !== current[f]);
      if (changed.length + switches.length > 0) {
        await record(t, 'settings.payment_changed', { vendorId: req.vendorId, actor: req.vendorEmail, ip: clientIp(req), detail: { changed: [...changed, ...switches] } });
      }
      return rows[0];
    });
    if (changed.length > 0) {
      // Not awaited: saving must not depend on the mail server.
      Promise.resolve(mailer.send(paymentKeysChangedEmail({ to: owner.email, name: owner.name }))).catch((err) =>
        console.error('[mail] could not send the payment settings notice:', err.message),
      );
    }
    res.json({ data: out(saved, apiBaseOf(req)) });
  });

  // Makes one authenticated call to the gateway (Razorpay, or PhonePe when the body says {provider: 'phonepe'})
  // with the saved keys so mistakes show up here, not at a customer's table.
  router.post('/test', async (req, res) => {
    const s = await loadSettings(db, req.vendorId);
    if (req.body?.provider === 'phonepe') {
      if (!GATEWAYS.phonepe.configured(s)) throw conflict('PHONEPE_NOT_CONFIGURED', 'Save your PhonePe Client ID, Client Version and Client Secret first.');
      await pingPhonepe(GATEWAYS.phonepe.creds(s));
      return res.json({ data: { ok: true, mode: 'live' } });
    }
    if (!(s.razorpay_key_id && s.razorpay_key_secret_enc)) {
      throw conflict('RAZORPAY_NOT_CONFIGURED', 'Save your Razorpay Key ID and Key Secret first.');
    }
    if (!isUsableKeyId(s.razorpay_key_id)) {
      throw conflict('RAZORPAY_TEST_KEY', 'The saved key is a test key. Save your live Key ID and Key Secret first.');
    }
    await pingRazorpay({ keyId: s.razorpay_key_id, keySecret: decryptSecret(s.razorpay_key_secret_enc) });
    res.json({ data: { ok: true, mode: out(s).razorpay_mode } });
  });

  return router;
}

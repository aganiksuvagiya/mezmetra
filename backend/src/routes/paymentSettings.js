import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError, conflict, parse } from '../lib/errors.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { APP_ID_RE, cashfreeMode, pingCashfree } from '../lib/cashfree.js';
import { GATEWAYS } from '../lib/gateways.js';
import { CLIENT_ID_RE, CLIENT_VERSION_RE, phonepeWebhookAuth, pingPhonepe } from '../lib/phonepe.js';
import { MERCHANT_KEY_LENGTH, MID_RE, pingPaytm, WEBSITE_RE } from '../lib/paytm.js';
import { pingRazorpay } from '../lib/razorpay.js';
import { detectImageMime, IMAGE_TYPES } from '../lib/image.js';
import { VPA_RE } from '../lib/upi.js';

const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;

// The restaurant's own UPI QR: a screenshot or photo, so a megabyte is plenty (the admin shrinks it first).
const MAX_QR_BYTES = 1024 * 1024;

const putSchema = z.object({
  cash_enabled: z.boolean().optional(),
  upi_enabled: z.boolean().optional(),
  // The restaurant's UPI ID (VPA), e.g. name@okhdfcbank. An empty string clears it.
  upi_id: z.union([z.literal(''), z.string().trim().regex(VPA_RE, 'Enter a valid UPI ID, like name@bank')]).optional(),
  // Show the Google Pay / PhonePe / Paytm buttons (they only work for a business UPI ID).
  upi_pay_buttons: z.boolean().optional(),
  razorpay_enabled: z.boolean().optional(),
  razorpay_key_id: z.string().trim().regex(KEY_ID, 'Key ID looks like rzp_test_xxxxxxxx or rzp_live_xxxxxxxx').optional(),
  // Write-only: never returned by the API. Omit it to keep the saved secret.
  razorpay_key_secret: z.string().trim().min(8).max(100).optional(),
  cashfree_enabled: z.boolean().optional(),
  cashfree_app_id: z.string().trim().regex(APP_ID_RE, 'App ID is the short code from the Cashfree dashboard (letters and numbers only)').optional(),
  // Write-only, like the Razorpay secret.
  cashfree_secret: z.string().trim().min(8).max(200).optional(),
  phonepe_enabled: z.boolean().optional(),
  phonepe_client_id: z.string().trim().regex(CLIENT_ID_RE, 'Client ID is the code from the PhonePe Business dashboard (letters, numbers, - _ .)').optional(),
  phonepe_client_version: z.string().trim().regex(CLIENT_VERSION_RE, 'Client Version is a short value such as 1').optional(),
  // Write-only, like the Razorpay secret.
  phonepe_client_secret: z.string().trim().min(8).max(200).optional(),
  // PhonePe cannot tell from the keys whether they are its sandbox or real ones, so the restaurant says.
  phonepe_env: z.enum(['sandbox', 'live']).optional(),
  // Webhooks (the gateway tells us a payment succeeded): write-only secrets typed in the gateway's own dashboard.
  razorpay_webhook_secret: z.string().trim().min(8, 'Use at least 8 characters').max(100).optional(),
  phonepe_webhook_username: z.string().trim().min(4, 'Use at least 4 characters').max(80).optional(),
  phonepe_webhook_password: z.string().trim().min(8, 'Use at least 8 characters').max(100).optional(),
  paytm_enabled: z.boolean().optional(),
  paytm_mid: z.string().trim().regex(MID_RE, 'Merchant ID is the code from the Paytm dashboard (letters and numbers)').optional(),
  // Write-only. A Paytm Merchant Key is exactly 16 characters.
  paytm_merchant_key: z.string().trim().length(MERCHANT_KEY_LENGTH, `The Paytm Merchant Key is ${MERCHANT_KEY_LENGTH} characters long`).optional(),
  // Empty = the usual one (WEBSTAGING for the sandbox, DEFAULT for live).
  paytm_website: z.union([z.literal(''), z.string().trim().regex(WEBSITE_RE, 'Website name is a short word such as DEFAULT')]).optional(),
  paytm_env: z.enum(['sandbox', 'live']).optional(),
});

const out = (s, apiBase = '') => ({
  // Ways of paying the product offers right now; the admin shows only these.
  methods_available: [...config.paymentMethods],
  cash_enabled: s.cash_enabled,
  upi_enabled: s.upi_enabled,
  upi_id: s.upi_id,
  upi_pay_buttons: s.upi_pay_buttons,
  // The restaurant's own UPI QR image (see migration 025), or null. The ?v= makes a replaced image a new URL.
  upi_qr_url: s.has_upi_qr ? `/api/public/vendors/${s.vendor_id}/upi-qr?v=${s.upi_qr_version}` : null,
  razorpay_enabled: s.razorpay_enabled,
  razorpay_key_id: s.razorpay_key_id,
  razorpay_secret_set: Boolean(s.razorpay_key_secret_enc),
  razorpay_mode: s.razorpay_key_id?.startsWith('rzp_live_') ? 'live' : s.razorpay_key_id ? 'test' : null,
  razorpay_configured: Boolean(s.razorpay_key_id && s.razorpay_key_secret_enc),
  cashfree_enabled: s.cashfree_enabled,
  cashfree_app_id: s.cashfree_app_id,
  cashfree_secret_set: Boolean(s.cashfree_secret_enc),
  cashfree_mode: s.cashfree_app_id ? (cashfreeMode(s.cashfree_app_id) === 'sandbox' ? 'test' : 'live') : null,
  cashfree_configured: Boolean(s.cashfree_app_id && s.cashfree_secret_enc),
  phonepe_enabled: s.phonepe_enabled,
  phonepe_client_id: s.phonepe_client_id,
  phonepe_client_version: s.phonepe_client_version,
  phonepe_secret_set: Boolean(s.phonepe_secret_enc),
  phonepe_env: s.phonepe_env,
  phonepe_configured: GATEWAYS.phonepe.configured(s),
  // Webhooks: the address to paste into the gateway's dashboard (private to this restaurant) and whether its secret is saved.
  webhook_url_razorpay: `${apiBase}/api/webhooks/razorpay/${s.webhook_key}`,
  webhook_url_phonepe: `${apiBase}/api/webhooks/phonepe/${s.webhook_key}`,
  razorpay_webhook_set: Boolean(s.razorpay_webhook_secret_enc),
  phonepe_webhook_set: Boolean(s.phonepe_webhook_auth_enc),
  paytm_enabled: s.paytm_enabled,
  paytm_mid: s.paytm_mid,
  paytm_key_set: Boolean(s.paytm_key_enc),
  paytm_website: s.paytm_website,
  paytm_env: s.paytm_env,
  paytm_configured: GATEWAYS.paytm.configured(s),
});

// Where the gateway can reach this server (the public address of the API).
const apiBaseOf = (req) => config.apiPublicUrl || `${req.protocol}://${req.get('host')}`;

async function loadSettings(q, vendorId) {
  await q.query(`INSERT INTO vendor_payment_settings (vendor_id) VALUES ($1) ON CONFLICT DO NOTHING`, [vendorId]);
  const { rows } = await q.query(`SELECT * FROM vendor_payment_settings WHERE vendor_id = $1`, [vendorId]);
  return rows[0];
}

export function paymentSettingsRouter(db) {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json({ data: out(await loadSettings(db, req.vendorId), apiBaseOf(req)) });
  });

  router.put('/', async (req, res) => {
    const body = parse(putSchema, req.body);
    const saved = await db.tx(async (t) => {
      const current = await loadSettings(t, req.vendorId);
      const keyId = body.razorpay_key_id ?? current.razorpay_key_id;
      const secretEnc = body.razorpay_key_secret ? encryptSecret(body.razorpay_key_secret) : current.razorpay_key_secret_enc;
      const razorpayEnabled = body.razorpay_enabled ?? current.razorpay_enabled;
      const cfAppId = body.cashfree_app_id ?? current.cashfree_app_id;
      const cfSecretEnc = body.cashfree_secret ? encryptSecret(body.cashfree_secret) : current.cashfree_secret_enc;
      const cashfreeEnabled = body.cashfree_enabled ?? current.cashfree_enabled;
      const ppEnabled = body.phonepe_enabled ?? current.phonepe_enabled;
      const ppClientId = body.phonepe_client_id ?? current.phonepe_client_id;
      const ppVersion = body.phonepe_client_version ?? current.phonepe_client_version;
      const ppSecretEnc = body.phonepe_client_secret ? encryptSecret(body.phonepe_client_secret) : current.phonepe_secret_enc;
      const ppEnv = body.phonepe_env ?? current.phonepe_env;
      const rzWebhookEnc = body.razorpay_webhook_secret ? encryptSecret(body.razorpay_webhook_secret) : current.razorpay_webhook_secret_enc;
      // PhonePe's username and password are only ever used as their hash, so only the hash is kept.
      if ((body.phonepe_webhook_username === undefined) !== (body.phonepe_webhook_password === undefined)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter both the webhook username and the webhook password.');
      }
      const ppWebhookEnc = body.phonepe_webhook_username
        ? encryptSecret(phonepeWebhookAuth(body.phonepe_webhook_username, body.phonepe_webhook_password))
        : current.phonepe_webhook_auth_enc;
      const ptEnabled = body.paytm_enabled ?? current.paytm_enabled;
      const ptMid = body.paytm_mid ?? current.paytm_mid;
      const ptKeyEnc = body.paytm_merchant_key ? encryptSecret(body.paytm_merchant_key) : current.paytm_key_enc;
      const ptWebsite = body.paytm_website === undefined ? current.paytm_website : body.paytm_website || null;
      const ptEnv = body.paytm_env ?? current.paytm_env;
      const cashEnabled = body.cash_enabled ?? current.cash_enabled;
      const upiId = body.upi_id === undefined ? current.upi_id : body.upi_id || null;
      const upiEnabled = body.upi_enabled ?? current.upi_enabled;
      const upiPayButtons = body.upi_pay_buttons ?? current.upi_pay_buttons;

      // Only ways of paying the product offers right now can be switched on (see PAYMENT_METHODS in the README).
      for (const [method, wanted, label] of [
        ['cash', body.cash_enabled, 'Cash payments'],
        ['upi', body.upi_enabled, 'UPI payments'],
        ['razorpay', body.razorpay_enabled, 'Online payments'],
        ['cashfree', body.cashfree_enabled, 'Online payments'],
        ['phonepe', body.phonepe_enabled, 'Online payments'],
        ['paytm', body.paytm_enabled, 'Online payments'],
      ]) {
        if (wanted === true && !config.paymentMethods.has(method)) {
          throw new HttpError(400, 'VALIDATION_ERROR', `${label} aren't available right now.`);
        }
      }

      if (razorpayEnabled && !(keyId && secretEnc)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter both the Razorpay Key ID and Key Secret before turning online payments on');
      }
      if (cashfreeEnabled && !(cfAppId && cfSecretEnc)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter both the Cashfree App ID and Secret Key before turning online payments on');
      }
      if (ppEnabled && !(ppClientId && ppVersion && ppSecretEnc)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter the PhonePe Client ID, Client Version and Client Secret before turning online payments on');
      }
      if (ptEnabled && !(ptMid && ptKeyEnc)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter both the Paytm Merchant ID and Merchant Key before turning online payments on');
      }
      // Diners get one "Pay online" button, so a restaurant uses one gateway at a time.
      if ([razorpayEnabled, cashfreeEnabled, ppEnabled, ptEnabled].filter(Boolean).length > 1) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Choose one online payment gateway: Razorpay, Cashfree, PhonePe or Paytm. Turn the others off first.');
      }
      if (upiEnabled && !upiId) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter your UPI ID before turning UPI payments on');
      }
      const allowed = config.paymentMethods;
      const onlineOn =
        (allowed.has('razorpay') && razorpayEnabled) ||
        (allowed.has('cashfree') && cashfreeEnabled) ||
        (allowed.has('phonepe') && ppEnabled) ||
        (allowed.has('paytm') && ptEnabled);
      if (!onlineOn && !(allowed.has('cash') && cashEnabled) && !(allowed.has('upi') && upiEnabled)) {
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          allowed.size === 1 && allowed.has('upi') ? 'Turn on UPI payments and enter your UPI ID, so diners can pay' : 'Keep at least one payment method turned on',
        );
      }
      const { rows } = await t.query(
        `UPDATE vendor_payment_settings
            SET cash_enabled = $2, razorpay_enabled = $3, razorpay_key_id = $4, razorpay_key_secret_enc = $5,
                upi_enabled = $6, upi_id = $7, upi_pay_buttons = $8,
                cashfree_enabled = $9, cashfree_app_id = $10, cashfree_secret_enc = $11,
                phonepe_enabled = $12, phonepe_client_id = $13, phonepe_client_version = $14, phonepe_secret_enc = $15, phonepe_env = $16,
                paytm_enabled = $17, paytm_mid = $18, paytm_key_enc = $19, paytm_website = $20, paytm_env = $21,
                razorpay_webhook_secret_enc = $22, phonepe_webhook_auth_enc = $23, updated_at = now()
          WHERE vendor_id = $1 RETURNING *`,
        [
          req.vendorId, cashEnabled, razorpayEnabled, keyId, secretEnc, upiEnabled, upiId, upiPayButtons, cashfreeEnabled, cfAppId, cfSecretEnc,
          ppEnabled, ppClientId, ppVersion, ppSecretEnc, ppEnv, ptEnabled, ptMid, ptKeyEnc, ptWebsite, ptEnv, rzWebhookEnc, ppWebhookEnc,
        ],
      );
      return rows[0];
    });
    res.json({ data: out(saved, apiBaseOf(req)) });
  });

  // The restaurant's own UPI QR (PhonePe Business / Paytm for Business accept money only through it): send the raw image bytes as
  // the body with Content-Type image/jpeg|png|webp.
  router.put('/upi-qr', express.raw({ type: IMAGE_TYPES, limit: MAX_QR_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'Send a JPEG, PNG or WebP image as the request body');
    }
    const mime = detectImageMime(req.body);
    if (!mime) throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'File is not a valid JPEG, PNG or WebP image');
    const saved = await db.tx(async (t) => {
      await loadSettings(t, req.vendorId);
      await t.query(
        `INSERT INTO vendor_upi_qr (vendor_id, mime, data) VALUES ($1, $2, $3)
         ON CONFLICT (vendor_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`,
        [req.vendorId, mime, req.body],
      );
      const { rows } = await t.query(
        `UPDATE vendor_payment_settings SET has_upi_qr = true, upi_qr_version = upi_qr_version + 1, updated_at = now() WHERE vendor_id = $1 RETURNING *`,
        [req.vendorId],
      );
      return rows[0];
    });
    res.json({ data: out(saved, apiBaseOf(req)) });
  });

  router.delete('/upi-qr', async (req, res) => {
    const saved = await db.tx(async (t) => {
      await loadSettings(t, req.vendorId);
      await t.query(`DELETE FROM vendor_upi_qr WHERE vendor_id = $1`, [req.vendorId]);
      const { rows } = await t.query(
        `UPDATE vendor_payment_settings SET has_upi_qr = false, upi_qr_version = upi_qr_version + 1, updated_at = now() WHERE vendor_id = $1 RETURNING *`,
        [req.vendorId],
      );
      return rows[0];
    });
    res.json({ data: out(saved, apiBaseOf(req)) });
  });

  // Makes one authenticated call to the gateway (Razorpay, or the one the body names: {provider: 'cashfree' | 'phonepe' | 'paytm'})
  // with the saved keys so mistakes show up here, not at a customer's table.
  router.post('/test', async (req, res) => {
    const s = await loadSettings(db, req.vendorId);
    if (req.body?.provider === 'phonepe') {
      if (!GATEWAYS.phonepe.configured(s)) throw conflict('PHONEPE_NOT_CONFIGURED', 'Save your PhonePe Client ID, Client Version and Client Secret first.');
      await pingPhonepe(GATEWAYS.phonepe.creds(s));
      return res.json({ data: { ok: true, mode: s.phonepe_env === 'live' ? 'live' : 'test' } });
    }
    if (req.body?.provider === 'paytm') {
      if (!GATEWAYS.paytm.configured(s)) throw conflict('PAYTM_NOT_CONFIGURED', 'Save your Paytm Merchant ID and Merchant Key first.');
      await pingPaytm(GATEWAYS.paytm.creds(s));
      return res.json({ data: { ok: true, mode: s.paytm_env === 'live' ? 'live' : 'test' } });
    }
    if (req.body?.provider === 'cashfree') {
      if (!(s.cashfree_app_id && s.cashfree_secret_enc)) {
        throw conflict('CASHFREE_NOT_CONFIGURED', 'Save your Cashfree App ID and Secret Key first.');
      }
      await pingCashfree({ appId: s.cashfree_app_id, secret: decryptSecret(s.cashfree_secret_enc) });
      return res.json({ data: { ok: true, mode: out(s).cashfree_mode } });
    }
    if (!(s.razorpay_key_id && s.razorpay_key_secret_enc)) {
      throw conflict('RAZORPAY_NOT_CONFIGURED', 'Save your Razorpay Key ID and Key Secret first.');
    }
    await pingRazorpay({ keyId: s.razorpay_key_id, keySecret: decryptSecret(s.razorpay_key_secret_enc) });
    res.json({ data: { ok: true, mode: out(s).razorpay_mode } });
  });

  return router;
}

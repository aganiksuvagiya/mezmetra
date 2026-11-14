import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError, conflict, parse } from '../lib/errors.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { APP_ID_RE, cashfreeMode, pingCashfree } from '../lib/cashfree.js';
import { pingRazorpay } from '../lib/razorpay.js';
import { VPA_RE } from '../lib/upi.js';

const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;

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
});

const out = (s) => ({
  // Ways of paying the product offers right now; the admin shows only these.
  methods_available: [...config.paymentMethods],
  cash_enabled: s.cash_enabled,
  upi_enabled: s.upi_enabled,
  upi_id: s.upi_id,
  upi_pay_buttons: s.upi_pay_buttons,
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
});

async function loadSettings(q, vendorId) {
  await q.query(`INSERT INTO vendor_payment_settings (vendor_id) VALUES ($1) ON CONFLICT DO NOTHING`, [vendorId]);
  const { rows } = await q.query(`SELECT * FROM vendor_payment_settings WHERE vendor_id = $1`, [vendorId]);
  return rows[0];
}

export function paymentSettingsRouter(db) {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json({ data: out(await loadSettings(db, req.vendorId)) });
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
      // Diners get one "Pay online" button, so a restaurant uses one gateway at a time.
      if (razorpayEnabled && cashfreeEnabled) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Choose one online payment gateway: Razorpay or Cashfree. Turn the other one off first.');
      }
      if (upiEnabled && !upiId) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter your UPI ID before turning UPI payments on');
      }
      const allowed = config.paymentMethods;
      const onlineOn = (allowed.has('razorpay') && razorpayEnabled) || (allowed.has('cashfree') && cashfreeEnabled);
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
                cashfree_enabled = $9, cashfree_app_id = $10, cashfree_secret_enc = $11, updated_at = now()
          WHERE vendor_id = $1 RETURNING *`,
        [req.vendorId, cashEnabled, razorpayEnabled, keyId, secretEnc, upiEnabled, upiId, upiPayButtons, cashfreeEnabled, cfAppId, cfSecretEnc],
      );
      return rows[0];
    });
    res.json({ data: out(saved) });
  });

  // Makes one authenticated call to the gateway (Razorpay, or Cashfree when the body says {provider: 'cashfree'}) with the saved
  // keys so mistakes show up here, not at a customer's table.
  router.post('/test', async (req, res) => {
    const s = await loadSettings(db, req.vendorId);
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

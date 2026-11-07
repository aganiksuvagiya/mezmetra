import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError, conflict, parse } from '../lib/errors.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { pingRazorpay } from '../lib/razorpay.js';
import { MOBILE_RE, VPA_RE, normalizeMobile } from '../lib/upi.js';

const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;

const putSchema = z.object({
  cash_enabled: z.boolean().optional(),
  upi_enabled: z.boolean().optional(),
  // The restaurant's UPI ID (VPA), e.g. name@okhdfcbank. An empty string clears it.
  upi_id: z.union([z.literal(''), z.string().trim().regex(VPA_RE, 'Enter a valid UPI ID, like name@bank')]).optional(),
  // The restaurant's mobile number for "Pay phone number" in any UPI app. An empty string clears it.
  upi_mobile: z
    .string()
    .trim()
    // Text without any digit stays as typed so it is rejected below (it must not silently count as "clear the number").
    .transform((v) => (v === '' ? '' : normalizeMobile(v) || v))
    .refine((v) => v === '' || MOBILE_RE.test(v), 'Enter a 10-digit mobile number, like 98765 43210')
    .optional(),
  // Show the Google Pay / PhonePe / Paytm buttons (they only work for a business UPI ID).
  upi_pay_buttons: z.boolean().optional(),
  razorpay_enabled: z.boolean().optional(),
  razorpay_key_id: z.string().trim().regex(KEY_ID, 'Key ID looks like rzp_test_xxxxxxxx or rzp_live_xxxxxxxx').optional(),
  // Write-only: never returned by the API. Omit it to keep the saved secret.
  razorpay_key_secret: z.string().trim().min(8).max(100).optional(),
});

const out = (s) => ({
  // Ways of paying the product offers right now; the admin shows only these.
  methods_available: [...config.paymentMethods],
  cash_enabled: s.cash_enabled,
  upi_enabled: s.upi_enabled,
  upi_id: s.upi_id,
  upi_mobile: s.upi_mobile,
  upi_pay_buttons: s.upi_pay_buttons,
  razorpay_enabled: s.razorpay_enabled,
  razorpay_key_id: s.razorpay_key_id,
  razorpay_secret_set: Boolean(s.razorpay_key_secret_enc),
  razorpay_mode: s.razorpay_key_id?.startsWith('rzp_live_') ? 'live' : s.razorpay_key_id ? 'test' : null,
  razorpay_configured: Boolean(s.razorpay_key_id && s.razorpay_key_secret_enc),
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
      const cashEnabled = body.cash_enabled ?? current.cash_enabled;
      const upiId = body.upi_id === undefined ? current.upi_id : body.upi_id || null;
      const upiMobile = body.upi_mobile === undefined ? current.upi_mobile : body.upi_mobile || null;
      const upiEnabled = body.upi_enabled ?? current.upi_enabled;
      const upiPayButtons = body.upi_pay_buttons ?? current.upi_pay_buttons;

      // Only ways of paying the product offers right now can be switched on (see PAYMENT_METHODS in the README).
      for (const [method, wanted, label] of [
        ['cash', body.cash_enabled, 'Cash payments'],
        ['upi', body.upi_enabled, 'UPI payments'],
        ['razorpay', body.razorpay_enabled, 'Online payments'],
      ]) {
        if (wanted === true && !config.paymentMethods.has(method)) {
          throw new HttpError(400, 'VALIDATION_ERROR', `${label} aren't available right now.`);
        }
      }

      if (razorpayEnabled && !(keyId && secretEnc)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter both the Razorpay Key ID and Key Secret before turning online payments on');
      }
      if (upiEnabled && !upiId && !upiMobile) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Enter your UPI ID or mobile number before turning UPI payments on');
      }
      const allowed = config.paymentMethods;
      if (!(allowed.has('razorpay') && razorpayEnabled) && !(allowed.has('cash') && cashEnabled) && !(allowed.has('upi') && upiEnabled)) {
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          allowed.size === 1 && allowed.has('upi') ? 'Turn on UPI payments and enter your UPI ID or mobile number, so diners can pay' : 'Keep at least one payment method turned on',
        );
      }
      const { rows } = await t.query(
        `UPDATE vendor_payment_settings
            SET cash_enabled = $2, razorpay_enabled = $3, razorpay_key_id = $4, razorpay_key_secret_enc = $5,
                upi_enabled = $6, upi_id = $7, upi_mobile = $8, upi_pay_buttons = $9, updated_at = now()
          WHERE vendor_id = $1 RETURNING *`,
        [req.vendorId, cashEnabled, razorpayEnabled, keyId, secretEnc, upiEnabled, upiId, upiMobile, upiPayButtons],
      );
      return rows[0];
    });
    res.json({ data: out(saved) });
  });

  // Makes one authenticated call to Razorpay with the saved keys so mistakes show up here, not at a
  // customer's table.
  router.post('/test', async (req, res) => {
    const s = await loadSettings(db, req.vendorId);
    if (!(s.razorpay_key_id && s.razorpay_key_secret_enc)) {
      throw conflict('RAZORPAY_NOT_CONFIGURED', 'Save your Razorpay Key ID and Key Secret first.');
    }
    await pingRazorpay({ keyId: s.razorpay_key_id, keySecret: decryptSecret(s.razorpay_key_secret_enc) });
    res.json({ data: { ok: true, mode: out(s).razorpay_mode } });
  });

  return router;
}

import { Router } from 'express';
import { decryptSecret, safeEqual } from '../lib/crypto.js';
import { HttpError, notFound } from '../lib/errors.js';
import { GATEWAYS } from '../lib/gateways.js';
import { markAttemptPaid } from '../lib/onlinePayments.js';
import { verifyWebhookSignature } from '../lib/razorpay.js';

// Payment webhooks: the gateway calls our server the moment a payment succeeds, so an order turns "Paid" even when the diner has closed
// the browser. Each restaurant has its own gateway account, so each has its own address (/api/webhooks/<gateway>/<webhook_key>) and
// its own secret. Every call is checked before anything changes:
//   Razorpay: the body is signed with the restaurant's webhook secret (HMAC), and the amount must match our payment attempt;
//   PhonePe:  the call carries the hash of the restaurant's webhook username:password, and then the server still asks PhonePe about
//             the order itself (so the body is only a nudge: nothing in it can mark an order paid).
// A call about something we do not know is answered 200 (so the gateway does not keep retrying it); a call that fails the check gets
// 400/401; and if we could not finish (PhonePe unreachable) 500, so the gateway retries.

const KEY = /^[a-f0-9]{32}$/;
const ok = (res, extra = {}) => res.json({ data: { ok: true, ...extra } });

export function webhooksRouter(db) {
  const router = Router();

  const settingsByKey = async (key) => {
    if (!KEY.test(key)) throw notFound('Webhook');
    const { rows } = await db.query(`SELECT * FROM vendor_payment_settings WHERE webhook_key = $1`, [key]);
    if (!rows[0]) throw notFound('Webhook');
    return rows[0];
  };

  const bodyText = (req) => (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
  const bodyJson = (req) => {
    try {
      return JSON.parse(bodyText(req));
    } catch {
      throw new HttpError(400, 'BAD_WEBHOOK', 'The body is not JSON.');
    }
  };

  /** The payment attempt we opened for this gateway order id, for this restaurant only. Late payments (attempt marked failed) count too. */
  const attemptFor = async (provider, providerOrderId, vendorId) => {
    const { rows } = await db.query(
      `SELECT p.id, p.order_id, p.amount_paise, p.status
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.provider = $1 AND p.provider_order_id = $2 AND o.vendor_id = $3
        ORDER BY p.id DESC LIMIT 1`,
      [provider, String(providerOrderId ?? ''), vendorId],
    );
    return rows[0] ?? null;
  };

  // --- Razorpay: order.paid, payment.captured (checkout) and qr_code.credited (scan-to-pay) -------------------------
  router.post('/razorpay/:key', async (req, res) => {
    const s = await settingsByKey(req.params.key);
    if (!s.razorpay_webhook_secret_enc) throw new HttpError(400, 'WEBHOOK_NOT_SET_UP', 'Save the webhook secret in Payments first.');
    const valid = verifyWebhookSignature({ secret: decryptSecret(s.razorpay_webhook_secret_enc), rawBody: bodyText(req), signature: req.get('x-razorpay-signature') });
    if (!valid) throw new HttpError(400, 'WEBHOOK_SIGNATURE_INVALID', 'The signature does not match.');

    const event = bodyJson(req);
    const payment = event?.payload?.payment?.entity;
    // The id of what we asked Razorpay to collect on: a checkout order ("order_...") or a UPI QR ("qr_...").
    const providerOrderId =
      event?.event === 'qr_code.credited' ? event?.payload?.qr_code?.entity?.id : payment?.order_id ?? event?.payload?.order?.entity?.id;
    if (!['order.paid', 'payment.captured', 'qr_code.credited'].includes(event?.event) || !payment || payment.status !== 'captured' || !providerOrderId) {
      return ok(res, { ignored: true });
    }

    const attempt = await attemptFor('razorpay', providerOrderId, s.vendor_id);
    if (!attempt) return ok(res, { ignored: true });
    if (attempt.status === 'paid') return ok(res, { already: true });
    if (Number(payment.amount) !== attempt.amount_paise) {
      // Somebody paid a different amount than the order: not marked paid; staff see it unpaid and look at the Razorpay dashboard.
      console.warn(`[webhook:razorpay] amount mismatch on ${providerOrderId}: got ${payment.amount}, expected ${attempt.amount_paise}`);
      return ok(res, { mismatch: true });
    }
    const done = await db.query(`SELECT 1 FROM payments WHERE provider = 'razorpay' AND provider_payment_id = $1`, [payment.id]);
    if (done.rows[0]) return ok(res, { already: true });
    const changed = await markAttemptPaid(db, { orderId: attempt.order_id, attemptId: attempt.id, paymentId: payment.id, method: 'razorpay' });
    return ok(res, { paid: changed });
  });

  // --- PhonePe: checkout.order.completed / checkout.order.failed ---------------------------------------------------
  router.post('/phonepe/:key', async (req, res) => {
    const s = await settingsByKey(req.params.key);
    if (!s.phonepe_webhook_auth_enc || !GATEWAYS.phonepe.configured(s)) {
      throw new HttpError(400, 'WEBHOOK_NOT_SET_UP', 'Save the PhonePe keys and the webhook username and password in Payments first.');
    }
    const sent = String(req.get('authorization') ?? '').replace(/^SHA256[ (]*/i, '').replace(/\)$/, '').trim().toLowerCase();
    if (!sent || !safeEqual(sent, decryptSecret(s.phonepe_webhook_auth_enc).toLowerCase())) {
      throw new HttpError(401, 'WEBHOOK_UNAUTHORIZED', 'The authorization header does not match.');
    }

    const event = bodyJson(req);
    const merchantOrderId = event?.payload?.merchantOrderId;
    if (!String(event?.event ?? '').startsWith('checkout.order') || !merchantOrderId) return ok(res, { ignored: true });

    const attempt = await attemptFor('phonepe', merchantOrderId, s.vendor_id);
    if (!attempt) return ok(res, { ignored: true });
    if (attempt.status === 'paid') return ok(res, { already: true });

    // The call is only a nudge: ask PhonePe for the truth. (If PhonePe cannot be reached this throws and PhonePe will call again.)
    const result = await GATEWAYS.phonepe.status(GATEWAYS.phonepe.creds(s), merchantOrderId);
    if (result.state !== 'paid') return ok(res, { state: result.state });
    if (result.amountPaise !== attempt.amount_paise) {
      console.warn(`[webhook:phonepe] amount mismatch on ${merchantOrderId}: got ${result.amountPaise}, expected ${attempt.amount_paise}`);
      return ok(res, { mismatch: true });
    }
    const changed = await markAttemptPaid(db, { orderId: attempt.order_id, attemptId: attempt.id, paymentId: result.paymentId, method: 'phonepe' });
    return ok(res, { paid: changed });
  });

  return router;
}

// What every way of confirming an online payment has in common: counting the money, exactly once.
import { record } from './audit.js';
import { decryptSecret } from './crypto.js';
import { closeRazorpayQr, razorpayReady } from './razorpay.js';

// Paying online is confirmed by the gateway itself, so the kitchen does not need to press "Accept": a pending order is accepted
// the moment the payment is verified (staff only press "Complete" when it is served). Cancelled and completed orders keep their status.
export const PAID_ONLINE_SQL = (method) => `UPDATE orders
       SET payment_status = 'paid', payment_method = '${method}', paid_at = now(),
           status = CASE WHEN status = 'pending' THEN 'accepted' ELSE status END,
           accepted_at = CASE WHEN status = 'pending' THEN now() ELSE accepted_at END
     WHERE id = $1 RETURNING *`;

/**
 * Money arrived for one payment attempt. Every way of confirming a payment goes through here, so each attempt is counted exactly once:
 *   'paid'   the order is now paid by this attempt;
 *   'extra'  the order had been paid already (it may since have been refunded), so this is money that is not owed: recorded and
 *            flagged for the restaurant to give back, and the order stays as it is;
 *   false    nothing changed: the attempt was counted before (a webhook and the diner's page can both report it), or given back.
 * Only an attempt that is still open ('created', or 'failed' and paid late after all) can become paid, never a refunded one, and
 * only an unpaid order can become paid: no notice, however late, brings a refunded order back to paid.
 * `source` says who reported it, for the record.
 */
export async function markAttemptPaid(db, { orderId, attemptId, paymentId, method, source }) {
  const outcome = await db.tx(async (t) => {
    const { rows } = await t.query(`SELECT id, vendor_id, payment_status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (!rows[0]) return false;
    const extra = rows[0].payment_status !== 'unpaid';
    const counted = await t.query(
      `UPDATE payments SET status = 'paid', provider_payment_id = $2, paid_at = now(), is_extra = $3
        WHERE id = $1 AND order_id = $4 AND status IN ('created', 'failed') RETURNING id`,
      [attemptId, paymentId ?? null, extra, orderId],
    );
    if (!counted.rows[0]) return false;
    if (!extra) await t.query(PAID_ONLINE_SQL(method), [orderId]);
    await record(t, extra ? 'payment.extra' : 'payment.paid', {
      vendorId: rows[0].vendor_id,
      orderId,
      paymentId: attemptId,
      actor: 'gateway',
      detail: { method, source },
    });
    return extra ? 'extra' : 'paid';
  });
  if (outcome === 'paid') await closeOpenQrs(db, orderId);
  return outcome;
}

/**
 * Another captured payment for an attempt that was counted already: recorded as a second payment ('extra'), to be given back.
 * False when this payment is on record. The order itself does not change.
 */
export async function recordSecondCapture(db, { attempt, paymentId, amountPaise }) {
  return db.tx(async (t) => {
    const order = (await t.query(`SELECT id, vendor_id FROM orders WHERE id = $1 FOR UPDATE`, [attempt.order_id])).rows[0];
    if (!order) return false;
    const added = await t.query(
      `INSERT INTO payments (order_id, provider, provider_order_id, provider_payment_id, amount_paise, status, paid_at, is_extra)
       VALUES ($1, 'razorpay', $2, $3, $4, 'paid', now(), true)
       ON CONFLICT (provider_payment_id) WHERE provider_payment_id IS NOT NULL DO NOTHING RETURNING id`,
      [order.id, attempt.provider_order_id, paymentId, amountPaise],
    );
    if (!added.rows[0]) return false;
    await record(t, 'payment.extra', {
      vendorId: order.vendor_id,
      orderId: order.id,
      paymentId: added.rows[0].id,
      actor: 'gateway',
      detail: { method: 'razorpay', source: 'webhook' },
    });
    return 'extra';
  });
}

/**
 * Closes the order's still-open Razorpay QR codes once it is paid another way or cancelled, so that nobody scans one and pays again.
 * Best effort: a QR code that cannot be closed is still watched by the re-check, and money paid on it is flagged.
 */
export async function closeOpenQrs(db, orderId, { log = console } = {}) {
  const { rows } = await db.query(
    `SELECT p.provider_order_id, s.razorpay_key_id, s.razorpay_key_secret_enc FROM payments p
       JOIN orders o ON o.id = p.order_id JOIN vendor_payment_settings s ON s.vendor_id = o.vendor_id
      WHERE p.order_id = $1 AND p.provider = 'razorpay' AND p.status = 'created' AND starts_with(p.provider_order_id, 'qr_')
        AND p.created_at > now() - interval '6 hours'`,
    [orderId],
  );
  for (const row of rows) {
    if (!razorpayReady(row)) continue;
    try {
      await closeRazorpayQr({ keyId: row.razorpay_key_id, keySecret: decryptSecret(row.razorpay_key_secret_enc), qrId: row.provider_order_id });
    } catch (err) {
      log.warn?.(`[razorpay-qr] could not close ${row.provider_order_id}: ${err.code ?? ''} ${err.message}`);
    }
  }
}

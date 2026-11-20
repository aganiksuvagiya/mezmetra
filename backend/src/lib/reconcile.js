import { decryptSecret } from './crypto.js';
import { GATEWAYS } from './gateways.js';
import { markAttemptPaid } from './onlinePayments.js';
import { fetchRazorpayOrderPayments, fetchRazorpayQrPayments } from './razorpay.js';

// The safety net behind the webhooks. A webhook can be missed (the server was asleep or down, the gateway gave up retrying), and
// a diner can pay and close the page. So every few minutes the server asks the gateway about the online payments that are still open
// for orders that are not paid yet, and marks the ones that really arrived. Nothing is believed that the gateway does not say itself.

const MIN_AGE_MINUTES = 2; // give the normal flow (the diner's own page, the webhook) a moment first
const MAX_AGE_HOURS = 24;
const MAX_PER_RUN = 50;

/** Asks the gateway about one open attempt. Returns { paymentId } when the right amount has arrived, otherwise null. */
async function arrived(attempt, settings) {
  if (attempt.provider === 'razorpay') {
    if (!settings.razorpay_key_id || !settings.razorpay_key_secret_enc) return null;
    const creds = { keyId: settings.razorpay_key_id, keySecret: decryptSecret(settings.razorpay_key_secret_enc) };
    const list = attempt.provider_order_id.startsWith('qr_')
      ? await fetchRazorpayQrPayments({ ...creds, qrId: attempt.provider_order_id })
      : await fetchRazorpayOrderPayments({ ...creds, orderId: attempt.provider_order_id });
    const hit = (list?.items ?? []).find((p) => p.status === 'captured' && Number(p.amount) === attempt.amount_paise);
    return hit ? { paymentId: hit.id } : null;
  }
  const gateway = GATEWAYS[attempt.provider];
  if (!gateway || !gateway.configured(settings)) return null;
  const result = await gateway.status(gateway.creds(settings), attempt.provider_order_id);
  return result.state === 'paid' && result.amountPaise === attempt.amount_paise ? { paymentId: result.paymentId } : null;
}

/** One pass of the safety net. Returns how many attempts were checked and how many turned out paid. */
export async function reconcileOnce(db, { log = console } = {}) {
  const { rows } = await db.query(
    `SELECT p.id AS attempt_id, p.order_id, p.provider, p.provider_order_id, p.amount_paise, o.vendor_id
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'created' AND p.provider IN ('razorpay', 'phonepe', 'paytm')
        AND p.created_at < now() - make_interval(mins => $1) AND p.created_at > now() - make_interval(hours => $2)
        AND o.payment_status <> 'paid' AND o.status <> 'cancelled'
      ORDER BY p.id LIMIT $3`,
    [MIN_AGE_MINUTES, MAX_AGE_HOURS, MAX_PER_RUN],
  );
  const settingsByVendor = new Map();
  let paid = 0;
  for (const row of rows) {
    try {
      if (!settingsByVendor.has(row.vendor_id)) {
        const s = await db.query(`SELECT * FROM vendor_payment_settings WHERE vendor_id = $1`, [row.vendor_id]);
        settingsByVendor.set(row.vendor_id, s.rows[0] ?? null);
      }
      const settings = settingsByVendor.get(row.vendor_id);
      if (!settings) continue;
      const hit = await arrived({ ...row, amount_paise: Number(row.amount_paise) }, settings);
      if (hit && (await markAttemptPaid(db, { orderId: row.order_id, attemptId: row.attempt_id, paymentId: hit.paymentId, method: row.provider }))) {
        paid += 1;
        log.info?.(`[reconcile] order ${row.order_id} was paid on ${row.provider} (${row.provider_order_id}); marked paid`);
      }
    } catch (err) {
      // One gateway being unreachable must not stop the others; the next pass tries again.
      log.warn?.(`[reconcile] ${row.provider} ${row.provider_order_id}: ${err.code ?? ''} ${err.message}`);
    }
  }
  return { checked: rows.length, paid };
}

/** Runs reconcileOnce every few minutes for as long as the server lives (and once shortly after it starts). */
export function startReconciler(db, { intervalMs = 5 * 60_000, firstAfterMs = 30_000 } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileOnce(db);
    } catch (err) {
      console.warn('[reconcile] failed:', err.message);
    } finally {
      running = false;
    }
  };
  setTimeout(run, firstAfterMs).unref();
  setInterval(run, intervalMs).unref();
}

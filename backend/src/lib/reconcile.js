import { decryptSecret } from './crypto.js';
import { GATEWAYS } from './gateways.js';
import { markAttemptPaid } from './onlinePayments.js';
import { sweepRateLimits } from './rateLimit.js';
import { coversAmount, fetchRazorpayOrderPayments, fetchRazorpayQrPayments, razorpayReady } from './razorpay.js';
import { reconcileRefunds } from './refunds.js';

// The safety net behind the webhooks. A webhook can be missed (the server was asleep or down, the gateway gave up retrying), and
// a diner can pay and close the page. So every few minutes the server asks the gateway about the online payments that are still open
// and records the ones that really arrived. There are two queues: orders still waiting for money, and the rest (paid, refunded or
// cancelled orders, where a payment is money to give back). Each pass takes from both, the first more, and within a queue the
// attempts asked about longest ago go first, so every open attempt gets its turn however many there are. Nothing is believed that
// the gateway does not say itself.

const MIN_AGE_MINUTES = 2; // give the normal flow (the diner's own page, the webhook) a moment first
const MAX_AGE_HOURS = 24;
const MAX_PER_RUN = 50;
const WAITING_PER_RUN = 35; // of those, the places kept for orders still waiting for money; either queue may use what the other leaves
const GIVE_UP_AFTER_MS = 60 * 60_000; // a page the gateway calls failed, this long after it was opened, will not be paid any more

/** Asks the gateway about one open attempt: { paymentId } when the right amount has arrived, { failed: true }, or null. */
async function ask(attempt, settings) {
  if (attempt.provider === 'razorpay') {
    if (!razorpayReady(settings)) return null;
    const creds = { keyId: settings.razorpay_key_id, keySecret: decryptSecret(settings.razorpay_key_secret_enc) };
    const list = attempt.provider_order_id.startsWith('qr_')
      ? await fetchRazorpayQrPayments({ ...creds, qrId: attempt.provider_order_id })
      : await fetchRazorpayOrderPayments({ ...creds, orderId: attempt.provider_order_id });
    const hit = (list?.items ?? []).find((p) => p.status === 'captured' && coversAmount(p.amount, attempt.amount_paise));
    return hit ? { paymentId: hit.id } : null;
  }
  const gateway = GATEWAYS[attempt.provider];
  if (!gateway || !gateway.configured(settings)) return null;
  const result = await gateway.status(gateway.creds(settings), attempt.provider_order_id);
  if (result.state === 'paid' && result.amountPaise === attempt.amount_paise) return { paymentId: result.paymentId };
  return result.state === 'failed' ? { failed: true } : null;
}

const settingsOf = async (db, vendorId) => (await db.query(`SELECT * FROM vendor_payment_settings WHERE vendor_id = $1`, [vendorId])).rows[0] ?? null;

/** Checks one attempt row and records what the gateway says. Returns markAttemptPaid's outcome, or false. */
async function settle(db, row, settings, source, log) {
  await db.query(`UPDATE payments SET last_checked_at = now() WHERE id = $1`, [row.attempt_id]);
  if (!settings) return false;
  const answer = await ask({ ...row, amount_paise: Number(row.amount_paise) }, settings);
  if (answer?.failed) {
    if (Date.now() - new Date(row.created_at).getTime() > GIVE_UP_AFTER_MS) {
      await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'created'`, [row.attempt_id]);
    }
    return false;
  }
  if (!answer) return false;
  const outcome = await markAttemptPaid(db, { orderId: row.order_id, attemptId: row.attempt_id, paymentId: answer.paymentId, method: row.provider, source });
  if (outcome === 'paid') log.info?.(`[reconcile] order ${row.order_id} was paid on ${row.provider} (${row.provider_order_id}); marked paid`);
  if (outcome === 'extra') log.warn?.(`[reconcile] order ${row.order_id} was paid twice: ${row.provider} (${row.provider_order_id}) is recorded to be refunded`);
  return outcome;
}

const OPEN_ATTEMPTS = `
  SELECT p.id AS attempt_id, p.order_id, p.provider, p.provider_order_id, p.amount_paise, p.created_at, o.vendor_id
    FROM payments p JOIN orders o ON o.id = p.order_id
   WHERE p.status = 'created' AND p.provider IN ('razorpay', 'phonepe')`;

/**
 * Before staff take money at the counter: asks the gateways about this order's open online payments and records any that arrived.
 * True when one did. A gateway that cannot be reached does not stop the counter.
 */
export async function settleOpenAttempts(db, orderId, { log = console } = {}) {
  const { rows } = await db.query(`${OPEN_ATTEMPTS} AND p.order_id = $1 AND p.created_at > now() - make_interval(hours => $2) ORDER BY p.id DESC LIMIT 15`, [
    orderId,
    MAX_AGE_HOURS,
  ]);
  if (rows.length === 0) return false;
  const settings = await settingsOf(db, rows[0].vendor_id);
  let arrived = false;
  for (const row of rows) {
    try {
      if (await settle(db, row, settings, 'counter-check', log)) arrived = true;
    } catch (err) {
      log.warn?.(`[counter-check] ${row.provider} ${row.provider_order_id}: ${err.code ?? ''} ${err.message}`);
    }
  }
  return arrived;
}

/** One pass of the safety net. Returns how many attempts were checked and how many orders turned out paid. */
export async function reconcileOnce(db, { log = console } = {}) {
  const { rows } = await db.query(
    `WITH due AS (
       SELECT p.id AS attempt_id, p.order_id, p.provider, p.provider_order_id, p.amount_paise, p.created_at, p.last_checked_at, o.vendor_id,
              CASE WHEN o.payment_status = 'unpaid' AND o.status <> 'cancelled' THEN 0 ELSE 1 END AS queue
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.status = 'created' AND p.provider IN ('razorpay', 'phonepe')
          AND p.created_at < now() - make_interval(mins => $1) AND p.created_at > now() - make_interval(hours => $2)
     ), ranked AS (
       SELECT due.*, row_number() OVER (PARTITION BY queue ORDER BY last_checked_at NULLS FIRST, attempt_id) AS place FROM due
     )
     SELECT * FROM ranked
      ORDER BY (place > CASE queue WHEN 0 THEN $4::int ELSE $3::int - $4::int END), queue, place
      LIMIT $3::int`,
    [MIN_AGE_MINUTES, MAX_AGE_HOURS, MAX_PER_RUN, WAITING_PER_RUN],
  );
  const settingsByVendor = new Map();
  let paid = 0;
  for (const row of rows) {
    try {
      if (!settingsByVendor.has(row.vendor_id)) settingsByVendor.set(row.vendor_id, await settingsOf(db, row.vendor_id));
      if ((await settle(db, row, settingsByVendor.get(row.vendor_id), 'recheck', log)) === 'paid') paid += 1;
    } catch (err) {
      // One gateway being unreachable must not stop the others; the attempt goes to the back of the queue and gets another turn.
      log.warn?.(`[reconcile] ${row.provider} ${row.provider_order_id}: ${err.code ?? ''} ${err.message}`);
    }
  }
  return { checked: rows.length, paid };
}

/** Runs the safety net every few minutes for as long as the server lives (and once shortly after it starts). */
export function startReconciler(db, { intervalMs = 5 * 60_000, firstAfterMs = 30_000 } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileOnce(db);
      await reconcileRefunds(db);
      await sweepRateLimits(db);
      await db.query(`DELETE FROM revoked_tokens WHERE expires_at < now()`);
    } catch (err) {
      console.warn('[reconcile] failed:', err.message);
    } finally {
      running = false;
    }
  };
  setTimeout(run, firstAfterMs).unref();
  setInterval(run, intervalMs).unref();
}

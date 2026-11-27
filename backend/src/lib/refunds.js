// Giving money back, and finding out whether it really went. The order of things matters:
//   1. the request is put on record (refund_state 'requested'), in a transaction of its own;
//   2. the gateway is asked, with no transaction open;
//   3. the answer is recorded.
// When no clear answer arrives (a time-out, a restart, a failed write), the record stays 'requested' and the gateway is asked how the
// refund ended, by the next attempt of staff or by the re-check. A gateway may also accept a refund and finish (or fail) it later.
import { record } from './audit.js';
import { decryptSecret } from './crypto.js';
import { conflict, HttpError, notFound } from './errors.js';
import { GATEWAYS } from './gateways.js';
import { fetchRazorpayPaymentRefunds, fetchRazorpayRefund, refundRazorpayPayment } from './razorpay.js';

// A request younger than this may still be running (a gateway can take minutes with its time-outs and retries): nobody else touches
// it. One this old with nothing at the gateway has failed.
const IN_FLIGHT_MINUTES = 5;
const GIVE_UP_MINUTES = 10;

const razorpayState = (status) => (status === 'processed' ? 'processed' : status === 'failed' ? 'failed' : 'pending');
const razorpayCreds = (s) => ({ keyId: s.razorpay_key_id, keySecret: decryptSecret(s.razorpay_key_secret_enc) });
const labelOf = (provider) => (provider === 'razorpay' ? 'Razorpay' : GATEWAYS[provider]?.label ?? 'the payment gateway');
const newRef = (payment) => `mzr_${payment.id}_${Date.now().toString(36)}`;
const refused = (label) => new HttpError(502, 'REFUND_FAILED', `${label} did not give the money back. Nothing has changed; please check the ${label} dashboard and try again.`);
const unconfirmed = (label) =>
  new HttpError(
    502,
    'REFUND_UNCONFIRMED',
    `${label} did not confirm the refund. It may still have gone through: don't give the money back another way. We keep checking; try again in a few minutes.`,
  );

/** Throws when this payment cannot be refunded from here at all (nothing has been asked of the gateway yet). */
function assertRefundable(settings, payment) {
  if (payment.provider === 'razorpay') {
    if (!payment.provider_payment_id) throw conflict('REFUND_MANUAL', "We can't find the online payment for this order. Refund it from your Razorpay dashboard.");
    if (!(settings?.razorpay_key_id && settings.razorpay_key_secret_enc)) {
      throw conflict('RAZORPAY_NOT_CONFIGURED', 'Add your Razorpay keys in Payments first, or refund it from your Razorpay dashboard.');
    }
    return;
  }
  const gateway = GATEWAYS[payment.provider];
  if (!gateway) throw conflict('REFUND_MANUAL', 'Give this payment back the way it was made.');
  if (!gateway.configured(settings)) {
    throw conflict(`${payment.provider.toUpperCase()}_NOT_CONFIGURED`, `Add your ${gateway.label} keys in Payments first, or refund it from your ${gateway.label} dashboard.`);
  }
}

/** Asks the gateway to give all of `payment` back. Returns { refundId, ref, state }; throws when it refuses or does not answer. */
async function sendRefund(settings, payment, ref) {
  if (payment.provider === 'razorpay') {
    const refund = await refundRazorpayPayment({
      ...razorpayCreds(settings),
      paymentId: payment.provider_payment_id,
      amountPaise: Number(payment.amount_paise),
      notes: { order_id: String(payment.order_id), refund_ref: ref },
    });
    // An answer without a refund in it says nothing (it is neither a refund nor a refusal).
    if (!refund.id) throw unconfirmed('Razorpay');
    const state = razorpayState(refund.status);
    if (state === 'failed') throw refused('Razorpay');
    return { refundId: refund.id, ref: refund.id, state };
  }
  const gateway = GATEWAYS[payment.provider];
  const refund = await gateway.refund(gateway.creds(settings), { payment, refundId: ref, amountPaise: Number(payment.amount_paise) });
  if (refund.state === 'failed') throw refused(gateway.label);
  return { refundId: refund.refundId ?? ref, ref, state: refund.state };
}

/**
 * What the gateway knows about a refund of `payment`: { refundId, ref, state }, or null when it has none. Razorpay is asked for all
 * refunds of the payment (so one made in its dashboard is seen too); PhonePe is asked about our own refund id.
 */
async function lookUpRefund(settings, payment, ref) {
  if (payment.provider === 'razorpay') {
    const list = await fetchRazorpayPaymentRefunds({ ...razorpayCreds(settings), paymentId: payment.provider_payment_id });
    const refunds = list?.items ?? [];
    const live = refunds.filter((r) => r.status !== 'failed');
    if (live.reduce((n, r) => n + Number(r.amount), 0) >= Number(payment.amount_paise)) {
      return { refundId: live[0].id, ref: live[0].id, state: live.every((r) => r.status === 'processed') ? 'processed' : 'pending' };
    }
    return refunds.length > 0 && live.length === 0 ? { state: 'failed' } : null;
  }
  const gateway = GATEWAYS[payment.provider];
  try {
    const state = await gateway.refundStatus(gateway.creds(settings), ref);
    return { refundId: ref, ref, state };
  } catch (err) {
    if (err.gatewayStatus === 400 || err.gatewayStatus === 404) return null; // it knows no refund by that id
    throw err;
  }
}

/** True when the gateway's answer says for certain that it did not take the refund on. */
const isRefusal = (err) =>
  err.code === 'REFUND_FAILED' || err.code?.endsWith('_BAD_KEYS') || (err.gatewayStatus >= 400 && err.gatewayStatus < 500 && ![408, 409].includes(err.gatewayStatus));

/**
 * Records a refund the gateway has taken on (also one whose request had been given up on). True when the payment is on record as
 * refunded afterwards, whoever recorded it.
 */
async function complete(db, payment, requestRef, result, actor) {
  return db.tx(async (t) => {
    const order = (await t.query(`SELECT id, vendor_id FROM orders WHERE id = $1 FOR UPDATE`, [payment.order_id])).rows[0];
    if (!order) return false;
    const changed = await t.query(
      `UPDATE payments SET status = 'refunded', refund_id = $2, refund_ref = $3, refund_state = $4, refunded_at = now(), refund_checked_at = NULL
        WHERE id = $1 AND status = 'paid' AND refund_state IN ('requested', 'failed') AND refund_ref = $5 RETURNING id`,
      [payment.id, result.refundId, result.ref, result.state, requestRef],
    );
    if (!changed.rows[0]) return (await t.query(`SELECT 1 FROM payments WHERE id = $1 AND status = 'refunded'`, [payment.id])).rowCount > 0;
    // A second payment is given back on its own: the order, and what was really owed, stay as they are. Otherwise the order is
    // refunded, and cancelled too when the kitchen has not served it yet.
    if (!payment.is_extra) {
      await t.query(
        `UPDATE orders SET payment_status = 'refunded', status = CASE WHEN status IN ('pending', 'accepted') THEN 'cancelled' ELSE status END
          WHERE id = $1 AND payment_status = 'paid'`,
        [order.id],
      );
    }
    await record(t, 'payment.refund', {
      vendorId: order.vendor_id,
      orderId: order.id,
      paymentId: payment.id,
      actor,
      detail: { method: payment.provider, state: result.state, second_payment: Boolean(payment.is_extra) },
    });
    return true;
  });
}

/**
 * Closes a request the gateway did not take on: the payment stands as paid. `state` is what it says from now on. With `olderThan`
 * (minutes) it closes only a request nobody has made again since, checked in the same statement.
 */
const release = (db, paymentId, requestRef, state, { olderThan = 0 } = {}) =>
  db.query(
    `UPDATE payments SET refund_state = $3
      WHERE id = $1 AND refund_state = 'requested' AND refund_ref = $2 AND refund_requested_at <= now() - make_interval(mins => $4) RETURNING id`,
    [paymentId, requestRef, state, olderThan],
  );

/**
 * Gives one payment back, for staff. `pick(t, order)` runs with the order locked, checks that a refund is allowed and returns the
 * payment row. Throws, with nothing recorded as refunded, when the gateway refuses or does not confirm.
 */
export async function refundByStaff(db, { vendorId, orderId, actor, pick }) {
  const claim = await db.tx(async (t) => {
    const order = (await t.query(`SELECT * FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`, [orderId, vendorId])).rows[0];
    if (!order) throw notFound('Order');
    const picked = await pick(t, order);
    const payment = (
      await t.query(
        `SELECT *, refund_requested_at > now() - make_interval(mins => $2) AS refund_in_flight FROM payments WHERE id = $1`,
        [picked.id, IN_FLIGHT_MINUTES],
      )
    ).rows[0];
    const settings = (await t.query(`SELECT * FROM vendor_payment_settings WHERE vendor_id = $1`, [vendorId])).rows[0];
    assertRefundable(settings, payment);
    // An earlier request with no clear answer: while it may still be running, nobody asks twice; afterwards it is looked up first.
    const resuming = payment.refund_state === 'requested';
    if (resuming && payment.refund_in_flight) {
      throw conflict('REFUND_IN_PROGRESS', 'This refund is already being made. Wait a few minutes and look again.');
    }
    const ref = resuming ? payment.refund_ref : newRef(payment);
    await t.query(`UPDATE payments SET refund_state = 'requested', refund_ref = $2, refund_requested_at = now(), refund_checked_at = NULL WHERE id = $1`, [payment.id, ref]);
    return { payment, settings, ref, resuming, before: resuming ? 'failed' : payment.refund_state };
  });
  const { payment, settings, resuming } = claim;
  const label = labelOf(payment.provider);
  let { ref } = claim;
  // Success is reported only for a refund that is on record.
  const recordIt = async (requestRef, result) => {
    if (!(await complete(db, payment, requestRef, result, actor))) throw unconfirmed(label);
  };

  if (resuming) {
    const found = await lookUpRefund(settings, payment, ref).catch(() => {
      throw unconfirmed(label);
    });
    if (found && found.state !== 'failed') return recordIt(ref, found);
    if (found) {
      // That one failed for good: this is a new refund, with an id of its own.
      const next = newRef(payment);
      const renamed = await db.query(`UPDATE payments SET refund_ref = $3 WHERE id = $1 AND refund_ref = $2 AND refund_state = 'requested' RETURNING id`, [payment.id, ref, next]);
      if (!renamed.rows[0]) throw conflict('REFUND_IN_PROGRESS', 'This refund has just changed. Look at the order and try again.');
      ref = next;
    }
  }

  let result;
  try {
    result = await sendRefund(settings, payment, ref);
  } catch (err) {
    // Did it go through all the same (an answer that was lost, or "already refunded")?
    const found = await lookUpRefund(settings, payment, ref).catch(() => undefined);
    if (found && found.state !== 'failed') return recordIt(ref, found);
    if (!isRefusal(err)) throw unconfirmed(label);
    await release(db, payment.id, ref, claim.before);
    await record(db, 'payment.refund_refused', { vendorId, orderId: payment.order_id, paymentId: payment.id, actor });
    throw err;
  }
  return recordIt(ref, result);
}

async function outcomeAtGateway(settings, payment) {
  if (payment.provider === 'razorpay') {
    if (!settings?.razorpay_key_id || !settings.razorpay_key_secret_enc || !payment.refund_ref) return 'pending';
    return razorpayState((await fetchRazorpayRefund({ ...razorpayCreds(settings), refundId: payment.refund_ref })).status);
  }
  const gateway = GATEWAYS[payment.provider];
  if (!gateway?.configured(settings) || !payment.refund_ref) return 'pending';
  return gateway.refundStatus(gateway.creds(settings), payment.refund_ref);
}

/**
 * The gateway reports that a refund it had accepted failed: the money is still with the restaurant, so the payment counts as paid
 * again (as a second payment, to be given back, when the order has meanwhile been paid some other way).
 */
async function undoFailedRefund(db, payment) {
  await db.tx(async (t) => {
    const order = (await t.query(`SELECT id, vendor_id, payment_status FROM orders WHERE id = $1 FOR UPDATE`, [payment.order_id])).rows[0];
    if (!order) return;
    const extra = payment.is_extra || order.payment_status === 'paid';
    const changed = await t.query(
      `UPDATE payments SET status = 'paid', refund_state = 'failed', is_extra = $2
        WHERE id = $1 AND status = 'refunded' AND refund_state = 'pending' RETURNING id`,
      [payment.id, extra],
    );
    if (!changed.rows[0]) return;
    if (!extra) await t.query(`UPDATE orders SET payment_status = 'paid' WHERE id = $1 AND payment_status = 'refunded'`, [order.id]);
    await record(t, 'payment.refund_failed', { vendorId: order.vendor_id, orderId: order.id, paymentId: payment.id, actor: 'gateway' });
  });
}

/** A request that got no clear answer: asks the gateway what became of it. After a while with nothing there, it has failed. */
async function settleRequest(db, settings, payment) {
  const found = await lookUpRefund(settings, payment, payment.refund_ref);
  if (found && found.state !== 'failed') return complete(db, payment, payment.refund_ref, found, 'system');
  // Staff may have made the request again while the gateway was being asked: then it is left alone.
  const closed = await release(db, payment.id, payment.refund_ref, 'failed', { olderThan: found ? IN_FLIGHT_MINUTES : GIVE_UP_MINUTES });
  if (closed.rowCount > 0) {
    await record(db, 'payment.refund_failed', { vendorId: payment.vendor_id, orderId: payment.order_id, paymentId: payment.id, actor: 'system' });
  }
  return undefined;
}

/** Asks the gateways about refunds not finished yet: every few minutes at first, hourly after a day. */
export async function reconcileRefunds(db, { log = console, limit = 20 } = {}) {
  const { rows } = await db.query(
    `SELECT p.*, o.vendor_id FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE ((p.status = 'refunded' AND p.refund_state = 'pending'
              AND (p.refund_checked_at IS NULL
                   OR p.refund_checked_at < now() - CASE WHEN p.refunded_at > now() - interval '1 day' THEN interval '4 minutes' ELSE interval '1 hour' END))
          OR (p.status = 'paid' AND p.refund_state = 'requested' AND p.refund_requested_at < now() - make_interval(mins => $2)
              AND (p.refund_checked_at IS NULL OR p.refund_checked_at < now() - interval '4 minutes')))
      ORDER BY p.refund_checked_at NULLS FIRST, p.id LIMIT $1`,
    [limit, IN_FLIGHT_MINUTES],
  );
  for (const payment of rows) {
    try {
      await db.query(`UPDATE payments SET refund_checked_at = now() WHERE id = $1`, [payment.id]);
      const settings = (await db.query(`SELECT * FROM vendor_payment_settings WHERE vendor_id = $1`, [payment.vendor_id])).rows[0];
      if (payment.refund_state === 'requested') {
        assertRefundable(settings, payment);
        await settleRequest(db, settings, payment);
        continue;
      }
      const state = await outcomeAtGateway(settings, payment);
      if (state === 'processed') {
        await db.query(`UPDATE payments SET refund_state = 'processed' WHERE id = $1 AND refund_state = 'pending'`, [payment.id]);
        await record(db, 'payment.refund_processed', { vendorId: payment.vendor_id, orderId: payment.order_id, paymentId: payment.id, actor: 'gateway' });
      } else if (state === 'failed') {
        await undoFailedRefund(db, payment);
        log.warn?.(`[refunds] the refund of order ${payment.order_id} failed at ${payment.provider}; it counts as paid again`);
      }
    } catch (err) {
      log.warn?.(`[refunds] ${payment.provider} order ${payment.order_id}: ${err.code ?? ''} ${err.message}`);
    }
  }
  return { checked: rows.length };
}

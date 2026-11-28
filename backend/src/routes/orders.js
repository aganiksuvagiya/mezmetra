import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { record } from '../lib/audit.js';
import { conflict, notFound, parse } from '../lib/errors.js';
import { GATEWAYS, isRedirectGateway } from '../lib/gateways.js';
import { toRupees } from '../lib/money.js';
import { closeOpenQrs } from '../lib/onlinePayments.js';
import { writeReceipt } from '../lib/receipt.js';
import { settleOpenAttempts } from '../lib/reconcile.js';
import { refundByStaff } from '../lib/refunds.js';
import { adminOrderOut, loadOrderItems, loadPaymentNotes } from '../lib/serialize.js';

const listSchema = z.object({
  status: z.enum(['pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled', 'active']).optional(),
  payment: z.enum(['paid', 'unpaid']).optional(),
  q: z.string().trim().max(30).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

const statusSchema = z.object({ status: z.enum(['accepted', 'completed', 'cancelled']) });

// pending -> accepted -> completed; an order can be cancelled until it is completed (or paid).
const TRANSITIONS = {
  pending: ['accepted', 'cancelled'],
  accepted: ['completed', 'cancelled'],
};

// Money that needs a person, newest first: a second payment to give back, money that arrived for a cancelled order, and a refund the
// gateway could not finish or has not confirmed.
const ATTENTION_SQL = `
  SELECT kind, order_id, order_no, table_number, method, amount_paise, at FROM (
    SELECT 'paid_twice' AS kind, o.id AS order_id, o.order_no, o.table_number, p.provider AS method, p.amount_paise, p.paid_at AS at
      FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE o.vendor_id = $1 AND p.is_extra AND p.status = 'paid'
    UNION ALL
    SELECT 'cancelled_paid', o.id, o.order_no, o.table_number, o.payment_method, o.total_paise, o.paid_at
      FROM orders o
     WHERE o.vendor_id = $1 AND o.status = 'cancelled' AND o.payment_status = 'paid' AND o.payment_method <> 'cash'
    UNION ALL
    SELECT 'refund_failed', o.id, o.order_no, o.table_number, p.provider, p.amount_paise, p.refunded_at
      FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE o.vendor_id = $1 AND o.payment_status = 'paid' AND o.status <> 'cancelled' AND NOT p.is_extra AND p.status = 'paid' AND p.refund_state = 'failed'
    UNION ALL
    -- A refund the gateway has not confirmed for a long while: someone should look at its dashboard.
    SELECT 'refund_unconfirmed', o.id, o.order_no, o.table_number, p.provider, p.amount_paise, p.refund_requested_at
      FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE o.vendor_id = $1 AND NOT p.is_extra AND p.status = 'paid' AND p.refund_state = 'requested' AND p.refund_requested_at < now() - interval '15 minutes'
  ) a ORDER BY at DESC LIMIT 20`;

export function ordersRouter(db) {
  const router = Router();

  async function loadOne(q, id, vendorId) {
    const { rows } = await q.query(`SELECT * FROM orders WHERE id = $1 AND vendor_id = $2`, [id, vendorId]);
    if (!rows[0]) throw notFound('Order');
    const items = await loadOrderItems(q, [rows[0].id]);
    const notes = await loadPaymentNotes(q, [rows[0].id]);
    return adminOrderOut(rows[0], items.get(rows[0].id) ?? [], notes.get(rows[0].id));
  }

  /** The restaurant's order, locked for the rest of the transaction `t`. */
  async function lockOrder(t, req) {
    const { rows } = await t.query(`SELECT * FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`, [req.params.id, req.vendorId]);
    if (!rows[0]) throw notFound('Order');
    return rows[0];
  }

  router.get('/', async (req, res) => {
    const q = parse(listSchema, req.query);
    const where = ['o.vendor_id = $1'];
    const params = [req.vendorId];
    if (q.status === 'active') where.push(`o.status IN ('pending', 'accepted')`);
    // "preparing" and "ready" are the two halves of an accepted order: the kitchen has not, or has, marked it ready.
    else if (q.status === 'preparing') where.push(`o.status = 'accepted' AND o.ready_at IS NULL`);
    else if (q.status === 'ready') where.push(`o.status = 'accepted' AND o.ready_at IS NOT NULL`);
    else if (q.status) {
      params.push(q.status);
      where.push(`o.status = $${params.length}`);
    }
    if (q.payment) {
      params.push(q.payment);
      where.push(`o.payment_status = $${params.length}`);
    }
    if (q.q) {
      // Matches a table number (partial) or, when the search is all digits, that exact order number.
      params.push(`%${q.q}%`);
      const likeParam = `$${params.length}`;
      if (/^\d{1,15}$/.test(q.q)) {
        params.push(Number(q.q));
        where.push(`(o.table_number ILIKE ${likeParam} OR o.order_no = $${params.length})`);
      } else {
        where.push(`o.table_number ILIKE ${likeParam}`);
      }
    }
    const total = await db.query(`SELECT count(*) AS n FROM orders o WHERE ${where.join(' AND ')}`, params);
    params.push(q.per_page, (q.page - 1) * q.per_page);
    const { rows } = await db.query(
      `SELECT o.* FROM orders o WHERE ${where.join(' AND ')}
        ORDER BY o.created_at DESC, o.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const ids = rows.map((r) => r.id);
    const items = await loadOrderItems(db, ids);
    const notes = await loadPaymentNotes(db, ids);
    res.json({
      data: rows.map((r) => adminOrderOut(r, items.get(r.id) ?? [], notes.get(r.id))),
      meta: { page: q.page, per_page: q.per_page, total: total.rows[0].n },
    });
  });

  // (Before /:id, like /counts.)
  router.get('/attention', async (req, res) => {
    const { rows } = await db.query(ATTENTION_SQL, [req.vendorId]);
    res.json({
      data: rows.map((r) => ({
        kind: r.kind,
        order_id: r.order_id,
        order_number: r.order_no,
        table_number: r.table_number,
        method: r.method,
        amount: toRupees(r.amount_paise),
      })),
    });
  });

  // How many orders are in each state, for the figures and tabs above the list. (Before /:id, which would read "counts" as an id.)
  router.get('/counts', async (req, res) => {
    const { rows } = await db.query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE status = 'pending') AS pending,
              count(*) FILTER (WHERE status = 'accepted' AND ready_at IS NULL) AS preparing,
              count(*) FILTER (WHERE status = 'accepted' AND ready_at IS NOT NULL) AS ready,
              count(*) FILTER (WHERE status = 'completed') AS completed,
              count(*) FILTER (WHERE status = 'cancelled') AS cancelled
         FROM orders WHERE vendor_id = $1`,
      [req.vendorId],
    );
    const r = rows[0];
    const n = (v) => Number(v);
    res.json({
      data: { all: n(r.total), pending: n(r.pending), preparing: n(r.preparing), ready: n(r.ready), completed: n(r.completed), cancelled: n(r.cancelled), active: n(r.pending) + n(r.preparing) + n(r.ready) },
    });
  });

  router.get('/:id', async (req, res) => {
    res.json({ data: await loadOne(db, req.params.id, req.vendorId) });
  });

  router.patch('/:id/status', async (req, res) => {
    const { status } = parse(statusSchema, req.body);
    const order = await db.tx(async (t) => {
      const current = await lockOrder(t, req);
      if (!(TRANSITIONS[current.status] ?? []).includes(status)) {
        throw conflict('INVALID_TRANSITION', `This order is ${current.status}; it cannot be marked ${status}.`);
      }
      if (status === 'completed' && current.payment_status !== 'paid') {
        throw conflict('PAYMENT_REQUIRED', 'Record the payment before completing this order.');
      }
      if (status === 'cancelled' && current.payment_status === 'paid') {
        throw conflict('ALREADY_PAID', 'This order is already paid, so it cannot be cancelled. Refund it first (online payments can be refunded from the order).');
      }
      await t.query(
        `UPDATE orders SET status = $2::text,
           accepted_at  = CASE WHEN $2::text = 'accepted'  THEN now() ELSE accepted_at END,
           completed_at = CASE WHEN $2::text = 'completed' THEN now() ELSE completed_at END
         WHERE id = $1`,
        [current.id, status],
      );
      return loadOne(t, current.id, req.vendorId);
    });
    if (status === 'cancelled') await closeOpenQrs(db, order.id);
    res.json({ data: order });
  });

  // The kitchen has finished the order: the diner is told it is ready. The order stays "accepted" until staff complete it.
  router.post('/:id/ready', async (req, res) => {
    const order = await db.tx(async (t) => {
      const current = await lockOrder(t, req);
      if (current.status !== 'accepted') {
        throw conflict('INVALID_TRANSITION', `This order is ${current.status}; only an accepted order can be marked ready.`);
      }
      if (!current.ready_at) await t.query(`UPDATE orders SET ready_at = now() WHERE id = $1`, [current.id]);
      return loadOne(t, current.id, req.vendorId);
    });
    res.json({ data: order });
  });

  // Gives an online payment (Razorpay or PhonePe) back, in full. The order is cancelled too when the kitchen has not served it
  // yet. Cash is not refunded here: the staff hand the money back themselves.
  router.post('/:id/refund', async (req, res) => {
    await refundByStaff(db, {
      vendorId: req.vendorId,
      orderId: req.params.id,
      actor: req.vendorEmail,
      pick: async (t, order) => {
        if (order.payment_status === 'refunded') throw conflict('ALREADY_REFUNDED', 'This order was already refunded.');
        if (order.payment_status !== 'paid') throw conflict('NOT_PAID', 'Only a paid order can be refunded.');
        const method = order.payment_method;
        if (method !== 'razorpay' && !isRedirectGateway(method)) {
          throw conflict('REFUND_MANUAL', 'Only Razorpay and PhonePe payments can be refunded here. Give other payments back the way they were made.');
        }
        // The payment that made the order paid; a second payment on the same order is given back on its own (below).
        const payment = (
          await t.query(`SELECT id FROM payments WHERE order_id = $1 AND provider = $2 AND status = 'paid' AND NOT is_extra ORDER BY id DESC LIMIT 1`, [order.id, method])
        ).rows[0];
        if (!payment) throw conflict('REFUND_MANUAL', `We can't find the online payment for this order. Refund it from your ${method === 'razorpay' ? 'Razorpay' : GATEWAYS[method].label} dashboard.`);
        return payment;
      },
    });
    res.json({ data: await loadOne(db, req.params.id, req.vendorId) });
  });

  // Gives back a second payment that reached an already paid order. The order itself (and what was really owed) stays as it is.
  router.post('/:id/extra-payments/:paymentId/refund', async (req, res) => {
    await refundByStaff(db, {
      vendorId: req.vendorId,
      orderId: req.params.id,
      actor: req.vendorEmail,
      pick: async (t, order) => {
        const payment = (await t.query(`SELECT id, status FROM payments WHERE id = $1 AND order_id = $2 AND is_extra`, [req.params.paymentId, order.id])).rows[0];
        if (!payment) throw notFound('Payment');
        if (payment.status !== 'paid') throw conflict('ALREADY_REFUNDED', 'This payment was already given back.');
        return payment;
      },
    });
    res.json({ data: await loadOne(db, req.params.id, req.vendorId) });
  });

  // Staff took cash (or card at the counter) for this order.
  router.post('/:id/cash-payment', async (req, res) => {
    if (!config.paymentMethods.has('cash')) {
      throw conflict('METHOD_NOT_AVAILABLE', "Cash payments aren't available right now.");
    }
    // First make sure the diner has not just paid online: asking the gateway now saves a double payment.
    const mine = (await db.query(`SELECT id, payment_status FROM orders WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId])).rows[0];
    const arrivedOnline = mine && mine.payment_status !== 'paid' ? await settleOpenAttempts(db, mine.id) : false;
    const order = await db.tx(async (t) => {
      const current = await lockOrder(t, req);
      if (current.payment_status === 'paid') {
        throw conflict('ALREADY_PAID', arrivedOnline ? "This order has just been paid online, so don't take cash." : 'This order is already paid.');
      }
      if (current.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'This order was cancelled.');
      if (current.payment_status === 'refunded') throw conflict('ALREADY_REFUNDED', 'This order was refunded, so no payment is recorded on it.');
      const paid = await t.query(
        `INSERT INTO payments (order_id, provider, amount_paise, status, paid_at, recorded_by) VALUES ($1, 'cash', $2, 'paid', now(), $3) RETURNING id`,
        [current.id, current.total_paise, req.vendorEmail],
      );
      await t.query(`UPDATE orders SET payment_status = 'paid', payment_method = 'cash', paid_at = now() WHERE id = $1`, [current.id]);
      await record(t, 'payment.cash', { vendorId: req.vendorId, orderId: current.id, paymentId: paid.rows[0].id, actor: req.vendorEmail });
      return loadOne(t, current.id, req.vendorId);
    });
    await closeOpenQrs(db, order.id);
    res.json({ data: order });
  });

  // Only an order that never involved money can be removed: anything paid, refunded or being paid stays on record.
  router.delete('/:id', async (req, res) => {
    await db.tx(async (t) => {
      const current = await lockOrder(t, req);
      const money = await t.query(`SELECT 1 FROM payments WHERE order_id = $1 AND status <> 'failed' LIMIT 1`, [current.id]);
      if (current.payment_status !== 'unpaid' || money.rowCount > 0) {
        throw conflict('ORDER_HAS_PAYMENTS', 'This order has a payment, so it stays on record. Cancel or refund it instead.');
      }
      await t.query(`DELETE FROM orders WHERE id = $1`, [current.id]);
      await record(t, 'order.deleted', { vendorId: req.vendorId, orderId: current.id, actor: req.vendorEmail, detail: { number: current.order_no } });
    });
    res.status(204).end();
  });

  // Receipts are rendered on demand from the order itself, so there are no files to store or lose.
  router.get('/:id/receipt.pdf', async (req, res) => {
    const order = await loadOne(db, req.params.id, req.vendorId);
    if (order.payment_status !== 'paid') throw conflict('NOT_PAID', 'A receipt is available once the order is paid.');
    const { rows } = await db.query(
      `SELECT name, timezone, theme_primary, tax_percent, bill_name, bill_address, gstin, fssai, bill_contact FROM vendors WHERE id = $1`,
      [req.vendorId],
    );
    // A PDF can hold a JPEG or PNG picture only.
    const logo = await db.query(`SELECT data FROM vendor_logos WHERE vendor_id = $1 AND mime IN ('image/jpeg', 'image/png')`, [req.vendorId]);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="receipt-${order.number}.pdf"`,
      'Cache-Control': 'private, no-store',
    });
    writeReceipt(res, { vendor: { ...rows[0], logo: logo.rows[0] && Buffer.from(logo.rows[0].data) }, order });
  });

  return router;
}

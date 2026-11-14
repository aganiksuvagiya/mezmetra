import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { conflict, notFound, parse } from '../lib/errors.js';
import { decryptSecret } from '../lib/crypto.js';
import { refundRazorpayPayment } from '../lib/razorpay.js';
import { adminOrderOut, loadOrderItems } from '../lib/serialize.js';
import { writeReceipt } from '../lib/receipt.js';
import { UPI_REFERENCE_RE } from '../lib/upi.js';

const listSchema = z.object({
  status: z.enum(['pending', 'accepted', 'completed', 'cancelled', 'active']).optional(),
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

export function ordersRouter(db) {
  const router = Router();

  async function loadOne(q, id, vendorId) {
    const { rows } = await q.query(`SELECT * FROM orders WHERE id = $1 AND vendor_id = $2`, [id, vendorId]);
    if (!rows[0]) throw notFound('Order');
    const items = await loadOrderItems(q, [rows[0].id]);
    return adminOrderOut(rows[0], items.get(rows[0].id) ?? []);
  }

  router.get('/', async (req, res) => {
    const q = parse(listSchema, req.query);
    const where = ['o.vendor_id = $1'];
    const params = [req.vendorId];
    if (q.status === 'active') where.push(`o.status IN ('pending', 'accepted')`);
    else if (q.status) {
      params.push(q.status);
      where.push(`o.status = $${params.length}`);
    }
    if (q.payment) {
      params.push(q.payment);
      where.push(`o.payment_status = $${params.length}`);
    }
    if (q.q) {
      // Matches a table number (partial) or, when the search is all digits, that exact order id.
      params.push(`%${q.q}%`);
      const likeParam = `$${params.length}`;
      if (/^\d{1,15}$/.test(q.q)) {
        params.push(Number(q.q));
        where.push(`(o.table_number ILIKE ${likeParam} OR o.id = $${params.length})`);
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
    const items = await loadOrderItems(db, rows.map((r) => r.id));
    res.json({
      data: rows.map((r) => adminOrderOut(r, items.get(r.id) ?? [])),
      meta: { page: q.page, per_page: q.per_page, total: total.rows[0].n },
    });
  });

  router.get('/:id', async (req, res) => {
    res.json({ data: await loadOne(db, req.params.id, req.vendorId) });
  });

  router.patch('/:id/status', async (req, res) => {
    const { status } = parse(statusSchema, req.body);
    const order = await db.tx(async (t) => {
      const { rows } = await t.query(`SELECT * FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`, [req.params.id, req.vendorId]);
      const current = rows[0];
      if (!current) throw notFound('Order');
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
    res.json({ data: order });
  });

  // Staff took cash (or card at the counter) for this order.
  // The kitchen has finished the order: the diner is told it is ready. The order stays "accepted" until staff complete it.
  router.post('/:id/ready', async (req, res) => {
    const order = await db.tx(async (t) => {
      const { rows } = await t.query(`SELECT * FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`, [req.params.id, req.vendorId]);
      const current = rows[0];
      if (!current) throw notFound('Order');
      if (current.status !== 'accepted') {
        throw conflict('INVALID_TRANSITION', `This order is ${current.status}; only an accepted order can be marked ready.`);
      }
      if (!current.ready_at) await t.query(`UPDATE orders SET ready_at = now() WHERE id = $1`, [current.id]);
      return loadOne(t, current.id, req.vendorId);
    });
    res.json({ data: order });
  });

  // Gives an online (Razorpay) payment back, in full. The order is cancelled too when the kitchen has not served it yet. Cash and UPI
  // payments are not refunded here: the staff hand the money back themselves.
  router.post('/:id/refund', async (req, res) => {
    const order = await db.tx(async (t) => {
      const { rows } = await t.query(`SELECT * FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`, [req.params.id, req.vendorId]);
      const current = rows[0];
      if (!current) throw notFound('Order');
      if (current.payment_status === 'refunded') throw conflict('ALREADY_REFUNDED', 'This order was already refunded.');
      if (current.payment_status !== 'paid') throw conflict('NOT_PAID', 'Only a paid order can be refunded.');
      if (current.payment_method !== 'razorpay') {
        throw conflict('REFUND_MANUAL', 'Only online payments can be refunded here. For cash or UPI, hand the money back yourself.');
      }
      const payment = (
        await t.query(
          `SELECT id, provider_payment_id FROM payments WHERE order_id = $1 AND provider = 'razorpay' AND status = 'paid' ORDER BY id DESC LIMIT 1`,
          [current.id],
        )
      ).rows[0];
      if (!payment?.provider_payment_id) throw conflict('REFUND_MANUAL', "We can't find the online payment for this order. Refund it from your Razorpay dashboard.");
      const settings = (await t.query(`SELECT razorpay_key_id, razorpay_key_secret_enc FROM vendor_payment_settings WHERE vendor_id = $1`, [req.vendorId])).rows[0];
      if (!(settings?.razorpay_key_id && settings.razorpay_key_secret_enc)) {
        throw conflict('RAZORPAY_NOT_CONFIGURED', 'Add your Razorpay keys in Payments first, or refund it from your Razorpay dashboard.');
      }

      const refund = await refundRazorpayPayment({
        keyId: settings.razorpay_key_id,
        keySecret: decryptSecret(settings.razorpay_key_secret_enc),
        paymentId: payment.provider_payment_id,
        amountPaise: current.total_paise,
        notes: { order_id: String(current.id) },
      });
      await t.query(`UPDATE payments SET status = 'refunded', refund_id = $2, refunded_at = now() WHERE id = $1`, [payment.id, refund.id ?? null]);
      await t.query(
        `UPDATE orders SET payment_status = 'refunded',
           status = CASE WHEN status IN ('pending', 'accepted') THEN 'cancelled' ELSE status END
         WHERE id = $1`,
        [current.id],
      );
      return loadOne(t, current.id, req.vendorId);
    });
    res.json({ data: order });
  });

  router.post('/:id/cash-payment', async (req, res) => {
    if (!config.paymentMethods.has('cash')) {
      throw conflict('METHOD_NOT_AVAILABLE', "Cash payments aren't available right now. Orders are paid by UPI.");
    }
    const order = await db.tx(async (t) => {
      const { rows } = await t.query(`SELECT * FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`, [req.params.id, req.vendorId]);
      const current = rows[0];
      if (!current) throw notFound('Order');
      if (current.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'This order was cancelled.');
      if (current.payment_status === 'paid') throw conflict('ALREADY_PAID', 'This order is already paid.');
      await t.query(
        `INSERT INTO payments (order_id, provider, amount_paise, status, paid_at) VALUES ($1, 'cash', $2, 'paid', now())`,
        [current.id, current.total_paise],
      );
      await t.query(`UPDATE orders SET payment_status = 'paid', payment_method = 'cash', paid_at = now() WHERE id = $1`, [current.id]);
      return loadOne(t, current.id, req.vendorId);
    });
    res.json({ data: order });
  });

  // Staff checked their bank/UPI app and saw the money arrive (typically after the diner's "I've paid" claim).
  const upiSchema = z.object({
    reference: z.union([z.literal(''), z.string().trim().regex(UPI_REFERENCE_RE, 'The reference should be 6-30 letters or digits')]).optional(),
  });
  router.post('/:id/upi-payment', async (req, res) => {
    const body = parse(upiSchema, req.body ?? {});
    let order;
    try {
      order = await db.tx(async (t) => {
        const { rows } = await t.query(`SELECT * FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`, [req.params.id, req.vendorId]);
        const current = rows[0];
        if (!current) throw notFound('Order');
        if (current.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'This order was cancelled.');
        if (current.payment_status === 'paid') throw conflict('ALREADY_PAID', 'This order is already paid.');
        const reference = body.reference || current.claim_reference || null;
        await t.query(
          `INSERT INTO payments (order_id, provider, provider_payment_id, amount_paise, status, paid_at)
           VALUES ($1, 'upi', $2, $3, 'paid', now())`,
          [current.id, reference, current.total_paise],
        );
        await t.query(`UPDATE orders SET payment_status = 'paid', payment_method = 'upi', paid_at = now() WHERE id = $1`, [current.id]);
        return loadOne(t, current.id, req.vendorId);
      });
    } catch (err) {
      if (err?.code === '23505') throw conflict('DUPLICATE_REFERENCE', 'That UPI reference number was already used to confirm another order.');
      throw err;
    }
    res.json({ data: order });
  });

  router.delete('/:id', async (req, res) => {
    const { rowCount } = await db.query(`DELETE FROM orders WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId]);
    if (!rowCount) throw notFound('Order');
    res.status(204).end();
  });

  // Receipts are rendered on demand from the order itself, so there are no files to store or lose.
  router.get('/:id/receipt.pdf', async (req, res) => {
    const order = await loadOne(db, req.params.id, req.vendorId);
    if (order.payment_status !== 'paid') throw conflict('NOT_PAID', 'A receipt is available once the order is paid.');
    const { rows } = await db.query(`SELECT name, timezone FROM vendors WHERE id = $1`, [req.vendorId]);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="receipt-${order.id}.pdf"`,
      'Cache-Control': 'private, no-store',
    });
    writeReceipt(res, { vendor: rows[0], order });
  });

  return router;
}

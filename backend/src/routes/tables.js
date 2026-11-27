import { randomInt } from 'node:crypto';
import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { record } from '../lib/audit.js';
import { conflict, notFound, parse } from '../lib/errors.js';
import { closeOpenQrs } from '../lib/onlinePayments.js';
import { forgetAll } from '../lib/rateLimit.js';
import { settleOpenAttempts } from '../lib/reconcile.js';
import { loadOrderItems, tableOut } from '../lib/serialize.js';
import { toRupees } from '../lib/money.js';

const fields = {
  number: z.string().trim().min(1, 'Enter a table number').max(30),
  capacity: z.number().int().min(1, 'Capacity must be at least 1').max(100),
  area: z.string().trim().min(1).max(40),
  is_active: z.boolean(),
};
const createSchema = z.object({
  number: fields.number,
  capacity: fields.capacity,
  area: fields.area.default('Indoor'),
  is_active: fields.is_active.default(true),
});
const patchSchema = z.object(fields).partial();

const listSchema = z.object({
  area: z.string().trim().max(40).optional(),
  availability: z.enum(['available', 'occupied', 'maintenance']).optional(),
  q: z.string().trim().max(30).optional(),
});

const qrLink = (token) => `${config.customerAppUrl}/t/${token}`;
// The 4 digits printed on a table's card, from a cryptographic source.
const randomCode = () => String(randomInt(10_000)).padStart(4, '0');

// A table is "occupied" while it has an order that is still pending or accepted.
const SELECT = `
  SELECT t.*,
         EXISTS (SELECT 1 FROM orders o WHERE o.table_id = t.id AND o.status IN ('pending', 'accepted')) AS occupied
    FROM dining_tables t`;

export function tablesRouter(db) {
  const router = Router();

  router.get('/', async (req, res) => {
    const q = parse(listSchema, req.query);
    const where = ['t.vendor_id = $1'];
    const params = [req.vendorId];
    if (q.area) {
      params.push(q.area);
      where.push(`lower(t.area) = lower($${params.length})`);
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`t.number ILIKE $${params.length}`);
    }
    const { rows } = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY t.number`, params);
    let tables = rows.map((r) => tableOut(r, qrLink(r.qr_token)));
    if (q.availability) tables = tables.filter((t) => t.availability === q.availability);

    const active = tables.filter((t) => t.is_active);
    const occupied = tables.filter((t) => t.availability === 'occupied');
    res.json({
      data: tables,
      meta: {
        total: tables.length,
        total_capacity: tables.reduce((n, t) => n + t.capacity, 0),
        active_tables: active.length,
        occupied_tables: occupied.length,
        // Share of active tables that currently have a live order.
        occupancy_percent: active.length ? Math.round((occupied.length / active.length) * 100) : 0,
      },
    });
  });

  router.get('/areas', async (req, res) => {
    const { rows } = await db.query(`SELECT DISTINCT area FROM dining_tables WHERE vendor_id = $1 ORDER BY area`, [req.vendorId]);
    res.json({ data: rows.map((r) => r.area) });
  });

  router.post('/', async (req, res) => {
    const body = parse(createSchema, req.body);
    const { rows } = await db.query(
      `INSERT INTO dining_tables (vendor_id, number, capacity, area, is_active, code)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *, false AS occupied`,
      [req.vendorId, body.number, body.capacity, body.area, body.is_active, randomCode()],
    );
    res.status(201).json({ data: tableOut(rows[0], qrLink(rows[0].qr_token)) });
  });

  router.get('/:id', async (req, res) => {
    const { rows } = await db.query(`${SELECT} WHERE t.id = $1 AND t.vendor_id = $2`, [req.params.id, req.vendorId]);
    if (!rows[0]) throw notFound('Table');
    res.json({ data: tableOut(rows[0], qrLink(rows[0].qr_token)) });
  });

  // Only the fields present in the body change. (Editing the capacity of an inactive table must not
  // switch it back on.)
  router.patch('/:id', async (req, res) => {
    const body = parse(patchSchema, req.body);
    const { rowCount } = await db.query(
      `UPDATE dining_tables SET
         number     = COALESCE($3, number),
         capacity   = COALESCE($4, capacity),
         area       = COALESCE($5, area),
         is_active  = COALESCE($6, is_active),
         updated_at = now()
       WHERE id = $1 AND vendor_id = $2`,
      [req.params.id, req.vendorId, body.number ?? null, body.capacity ?? null, body.area ?? null, body.is_active ?? null],
    );
    if (!rowCount) throw notFound('Table');
    const { rows } = await db.query(`${SELECT} WHERE t.id = $1 AND t.vendor_id = $2`, [req.params.id, req.vendorId]);
    res.json({ data: tableOut(rows[0], qrLink(rows[0].qr_token)) });
  });

  // --- The table's running bill: every order of this table that is not paid yet (and not cancelled), added up. -----------------
  const openOrders = (q, tableId, vendorId, { lock = false } = {}) =>
    q.query(
      `SELECT * FROM orders WHERE table_id = $1 AND vendor_id = $2 AND payment_status = 'unpaid' AND status <> 'cancelled' ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
      [tableId, vendorId],
    );

  router.get('/:id/bill', async (req, res) => {
    const table = await db.query(`SELECT id, number FROM dining_tables WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId]);
    if (!table.rows[0]) throw notFound('Table');
    const { rows } = await openOrders(db, table.rows[0].id, req.vendorId);
    const items = await loadOrderItems(db, rows.map((o) => o.id));
    res.json({
      data: {
        table_number: table.rows[0].number,
        count: rows.length,
        total: toRupees(rows.reduce((n, o) => n + o.total_paise, 0)),
        orders: rows.map((o) => ({
          id: o.id,
          number: o.order_no,
          status: o.status,
          total: toRupees(o.total_paise),
          created_at: o.created_at,
          items: (items.get(o.id) ?? []).map((i) => ({ name: i.name, quantity: i.quantity })),
        })),
      },
    });
  });

  // One cash payment at the table for everything ordered so far: all its unpaid orders are marked paid together. Orders that come in
  // later get their own bill.
  // `order_ids`: the orders on the bill staff were looking at. If the bill has changed since (an order paid online, or a new one),
  // nothing is recorded, so the cash collected and the cash recorded cannot differ.
  const settleSchema = z.object({ method: z.enum(['cash']), order_ids: z.array(z.coerce.number().int().positive()).max(500).optional() });
  router.post('/:id/settle', async (req, res) => {
    const { method, order_ids: shown } = parse(settleSchema, req.body ?? {});
    if (!config.paymentMethods.has(method)) {
      throw conflict('METHOD_NOT_AVAILABLE', "Cash payments aren't available right now.");
    }
    // First make sure nobody at the table has just paid online: the cash to collect would be less than the bill shown.
    let arrivedOnline = false;
    for (const order of (await openOrders(db, req.params.id, req.vendorId)).rows) {
      if (await settleOpenAttempts(db, order.id)) arrivedOnline = true;
    }
    if (arrivedOnline) {
      throw conflict('PAID_ONLINE', 'Some of this bill has just been paid online. Close this and open the bill again to see what is left.');
    }
    const result = await db.tx(async (t) => {
      const table = await t.query(`SELECT id FROM dining_tables WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId]);
      if (!table.rows[0]) throw notFound('Table');
      const { rows } = await openOrders(t, table.rows[0].id, req.vendorId, { lock: true });
      if (rows.length === 0) throw conflict('NOTHING_TO_PAY', 'This table has no unpaid orders.');
      if (shown && (shown.length !== rows.length || rows.some((o) => !shown.includes(Number(o.id))))) {
        throw conflict('BILL_CHANGED', 'This bill has changed since you opened it. Check the new total before taking the money.');
      }
      for (const o of rows) {
        const paid = await t.query(
          `INSERT INTO payments (order_id, provider, amount_paise, status, paid_at, recorded_by) VALUES ($1, $2, $3, 'paid', now(), $4) RETURNING id`,
          [o.id, method, o.total_paise, req.vendorEmail],
        );
        await t.query(`UPDATE orders SET payment_status = 'paid', payment_method = $2, paid_at = now() WHERE id = $1`, [o.id, method]);
        await record(t, 'payment.cash', { vendorId: req.vendorId, orderId: o.id, paymentId: paid.rows[0].id, actor: req.vendorEmail, detail: { table_bill: true } });
      }
      return { ids: rows.map((o) => o.id), settled: rows.length, total: toRupees(rows.reduce((n, o) => n + o.total_paise, 0)) };
    });
    const { ids, ...summary } = result;
    for (const id of ids) await closeOpenQrs(db, id);
    res.json({ data: { ...summary, method } });
  });

  // A new random code (for example after it has been shared): the printed card must be replaced.
  router.post('/:id/code', async (req, res) => {
    const { rows } = await db.query(
      `UPDATE dining_tables SET code = $3, updated_at = now() WHERE id = $1 AND vendor_id = $2 RETURNING *, false AS occupied`,
      [req.params.id, req.vendorId, randomCode()],
    );
    if (!rows[0]) throw notFound('Table');
    await forgetAll(db, `code:${rows[0].id}`); // the new code starts with a clean count of wrong tries
    res.json({ data: tableOut(rows[0], qrLink(rows[0].qr_token)) });
  });

  // A new table link (for example after a photo of the QR code went around): the old link stops working, and the card is printed again.
  router.post('/:id/link', async (req, res) => {
    const { rows } = await db.query(
      `UPDATE dining_tables SET qr_token = replace(gen_random_uuid()::text, '-', ''), code = $3, updated_at = now()
        WHERE id = $1 AND vendor_id = $2 RETURNING *, false AS occupied`,
      [req.params.id, req.vendorId, randomCode()],
    );
    if (!rows[0]) throw notFound('Table');
    await forgetAll(db, `code:${rows[0].id}`);
    await record(db, 'table.new_link', { vendorId: req.vendorId, actor: req.vendorEmail, detail: { table: rows[0].number } });
    res.json({ data: tableOut(rows[0], qrLink(rows[0].qr_token)) });
  });

  router.delete('/:id', async (req, res) => {
    const { rowCount } = await db.query(`DELETE FROM dining_tables WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId]);
    if (!rowCount) throw notFound('Table');
    res.status(204).end();
  });

  // QR image for one table (PNG). The admin app fetches it with its auth header and shows a blob URL.
  router.get('/:id/qr.png', async (req, res) => {
    const { rows } = await db.query(`SELECT qr_token FROM dining_tables WHERE id = $1 AND vendor_id = $2`, [
      req.params.id,
      req.vendorId,
    ]);
    if (!rows[0]) throw notFound('Table');
    const size = Math.min(2048, Math.max(128, Number(req.query.size) || 1024));
    const png = await QRCode.toBuffer(qrLink(rows[0].qr_token), {
      type: 'png',
      width: size,
      margin: 2,
      errorCorrectionLevel: 'H',
    });
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' }).send(png); // a new link must never show the old code
  });

  return router;
}

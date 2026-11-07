import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { notFound, parse } from '../lib/errors.js';
import { tableOut } from '../lib/serialize.js';

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
      `INSERT INTO dining_tables (vendor_id, number, capacity, area, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *, false AS occupied`,
      [req.vendorId, body.number, body.capacity, body.area, body.is_active],
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
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' }).send(png);
  });

  return router;
}

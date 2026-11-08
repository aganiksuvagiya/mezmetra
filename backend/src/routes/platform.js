import { Router } from 'express';
import { z } from 'zod';
import { conflict, notFound, parse } from '../lib/errors.js';
import { toRupees } from '../lib/money.js';
import { isSuperAdminEmail } from '../lib/serialize.js';

// The platform owner's view: every restaurant on the product, with enough numbers to see who is active, and the switch
// to suspend or reactivate one. Mounted behind requireAuth + requireActiveVendor + requireSuperAdmin.

const listSchema = z.object({
  q: z.string().trim().max(60).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

const patchSchema = z.object({
  suspended: z.boolean(),
  // Shown to the restaurant when it tries to sign in.
  reason: z.string().trim().max(200).optional(),
});

const restaurantOut = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  created_at: r.created_at,
  status: r.suspended_at ? 'suspended' : 'active',
  suspended_at: r.suspended_at,
  suspended_reason: r.suspended_reason,
  is_platform_owner: isSuperAdminEmail(r.email),
  tables: Number(r.tables),
  items: Number(r.items),
  orders_total: Number(r.orders_total),
  orders_30d: Number(r.orders_30d),
  revenue_total: toRupees(Number(r.revenue_total_paise)),
  last_order_at: r.last_order_at,
  upi_ready: Boolean(r.upi_ready),
});

const SELECT_RESTAURANTS = `
  SELECT v.id, v.name, v.email, v.created_at, v.suspended_at, v.suspended_reason,
         (SELECT count(*) FROM dining_tables t WHERE t.vendor_id = v.id) AS tables,
         (SELECT count(*) FROM items i WHERE i.vendor_id = v.id) AS items,
         o.orders_total, o.orders_30d, o.revenue_total_paise, o.last_order_at,
         COALESCE(s.upi_enabled AND s.upi_id IS NOT NULL, false) AS upi_ready
    FROM vendors v
    LEFT JOIN vendor_payment_settings s ON s.vendor_id = v.id
    LEFT JOIN LATERAL (
      SELECT count(*) AS orders_total,
             count(*) FILTER (WHERE created_at >= now() - interval '30 days') AS orders_30d,
             COALESCE(sum(total_paise) FILTER (WHERE payment_status = 'paid'), 0) AS revenue_total_paise,
             max(created_at) AS last_order_at
        FROM orders WHERE vendor_id = v.id
    ) o ON true`;

export function platformRouter(db) {
  const router = Router();

  router.get('/overview', async (_req, res) => {
    const { rows } = await db.query(
      `SELECT (SELECT count(*) FROM vendors) AS total,
              (SELECT count(*) FROM vendors WHERE suspended_at IS NULL) AS active,
              (SELECT count(*) FROM vendors WHERE created_at >= now() - interval '30 days') AS new_30d,
              (SELECT count(*) FROM orders WHERE created_at >= now() - interval '30 days') AS orders_30d,
              (SELECT COALESCE(sum(total_paise), 0) FROM orders
                WHERE payment_status = 'paid' AND created_at >= now() - interval '30 days') AS revenue_30d_paise`,
    );
    const r = rows[0];
    res.json({
      data: {
        restaurants: { total: Number(r.total), active: Number(r.active), suspended: Number(r.total) - Number(r.active), new_30d: Number(r.new_30d) },
        orders_30d: Number(r.orders_30d),
        revenue_30d: toRupees(Number(r.revenue_30d_paise)),
      },
    });
  });

  router.get('/restaurants', async (req, res) => {
    const q = parse(listSchema, req.query);
    const where = [];
    const params = [];
    if (q.status === 'active') where.push('v.suspended_at IS NULL');
    if (q.status === 'suspended') where.push('v.suspended_at IS NOT NULL');
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(v.name ILIKE $${params.length} OR v.email ILIKE $${params.length})`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await db.query(`SELECT count(*) AS n FROM vendors v ${clause}`, params);
    params.push(q.per_page, (q.page - 1) * q.per_page);
    const { rows } = await db.query(
      `${SELECT_RESTAURANTS} ${clause} ORDER BY v.created_at DESC, v.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows.map(restaurantOut), meta: { page: q.page, per_page: q.per_page, total: Number(total.rows[0].n) } });
  });

  router.patch('/restaurants/:id', async (req, res) => {
    if (!/^\d{1,15}$/.test(req.params.id)) throw notFound('Restaurant');
    const body = parse(patchSchema, req.body ?? {});
    const out = await db.tx(async (t) => {
      const found = await t.query(`SELECT id, email FROM vendors WHERE id = $1 FOR UPDATE`, [req.params.id]);
      const vendor = found.rows[0];
      if (!vendor) throw notFound('Restaurant');
      if (body.suspended && (vendor.id === req.vendorId || isSuperAdminEmail(vendor.email))) {
        throw conflict('CANNOT_SUSPEND', "A platform owner's account can't be suspended.");
      }
      await t.query(
        `UPDATE vendors
            SET suspended_at     = CASE WHEN $2::boolean THEN COALESCE(suspended_at, now()) ELSE NULL END,
                suspended_reason = CASE WHEN $2::boolean THEN $3::text ELSE NULL END
          WHERE id = $1`,
        [vendor.id, body.suspended, body.reason || null],
      );
      const { rows } = await t.query(`${SELECT_RESTAURANTS} WHERE v.id = $1`, [vendor.id]);
      return restaurantOut(rows[0]);
    });
    res.json({ data: out });
  });

  return router;
}

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { conflict, HttpError, notFound, parse } from '../lib/errors.js';
import { toRupees } from '../lib/money.js';
import { isSuperAdminEmail } from '../lib/serialize.js';
import { signToken } from '../middleware/auth.js';

// The platform owner's console: every restaurant on the product with enough numbers to see who is active, a page per restaurant
// (profile, how it takes payments, recent orders, what the owner did to it) and the owner's actions on it: suspend / reactivate,
// set a new password, log in as it (to help with a problem) and delete it. Every action is written to platform_audit.
// Mounted behind requireAuth + requireActiveVendor + requireSuperAdmin.

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

const passwordSchema = z.object({ password: z.string().min(8, 'Use at least 8 characters').max(200) });
const deleteSchema = z.object({ confirm_name: z.string().trim().min(1, "Type the restaurant's name to confirm").max(200) });

const restaurantId = (req) => {
  if (!/^\d{1,15}$/.test(req.params.id)) throw notFound('Restaurant');
  return req.params.id;
};

/** One line in the owner's activity record. `q` is the database or a transaction. */
const audit = (q, req, action, target, detail = {}) =>
  q.query(
    `INSERT INTO platform_audit (actor_vendor_id, actor_email, action, target_vendor_id, target_name, target_email, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [req.vendorId, req.vendorEmail, action, target.id, target.name, target.email, JSON.stringify(detail)],
  );

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
      const found = await t.query(`SELECT id, name, email, suspended_at FROM vendors WHERE id = $1 FOR UPDATE`, [req.params.id]);
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
      if (body.suspended !== Boolean(vendor.suspended_at)) {
        await audit(t, req, body.suspended ? 'suspend' : 'reactivate', vendor, body.suspended && body.reason ? { reason: body.reason } : {});
      }
      const { rows } = await t.query(`${SELECT_RESTAURANTS} WHERE v.id = $1`, [vendor.id]);
      return restaurantOut(rows[0]);
    });
    res.json({ data: out });
  });

  // One restaurant in full: profile, numbers, how it takes payments (never the secrets), recent orders and the owner's record.
  router.get('/restaurants/:id', async (req, res) => {
    const id = restaurantId(req);
    const found = await db.query(`${SELECT_RESTAURANTS} WHERE v.id = $1`, [id]);
    if (!found.rows[0]) throw notFound('Restaurant');
    const [profile, settings, revenue, categories, recent, activity] = await Promise.all([
      db.query(`SELECT timezone, currency, tax_percent FROM vendors WHERE id = $1`, [id]),
      db.query(`SELECT * FROM vendor_payment_settings WHERE vendor_id = $1`, [id]),
      db.query(`SELECT COALESCE(sum(total_paise), 0) AS paise FROM orders WHERE vendor_id = $1 AND payment_status = 'paid' AND created_at >= now() - interval '30 days'`, [id]),
      db.query(`SELECT count(*) AS n FROM categories WHERE vendor_id = $1`, [id]),
      db.query(
        `SELECT order_no, table_number, status, payment_status, payment_method, total_paise, created_at
           FROM orders WHERE vendor_id = $1 ORDER BY id DESC LIMIT 10`,
        [id],
      ),
      db.query(`SELECT action, actor_email, detail, created_at FROM platform_audit WHERE target_vendor_id = $1 ORDER BY id DESC LIMIT 10`, [id]),
    ]);
    const st = settings.rows[0];
    // Per way of paying: is it switched on by the restaurant, is it set up (keys / UPI ID present), does the product offer it at all.
    const way = (key, enabled, configured) => ({ key, enabled: Boolean(enabled), configured: Boolean(configured), offered: config.paymentMethods.has(key) });
    const payment = [
      way('cash', st ? st.cash_enabled : true, true),
      way('upi', st?.upi_enabled, st?.upi_id),
      way('razorpay', st?.razorpay_enabled, st?.razorpay_key_id && st?.razorpay_key_secret_enc),
      way('cashfree', st?.cashfree_enabled, st?.cashfree_app_id && st?.cashfree_secret_enc),
      way('phonepe', st?.phonepe_enabled, st?.phonepe_client_id && st?.phonepe_client_version && st?.phonepe_secret_enc),
      way('paytm', st?.paytm_enabled, st?.paytm_mid && st?.paytm_key_enc),
    ];
    res.json({
      data: {
        ...restaurantOut(found.rows[0]),
        timezone: profile.rows[0].timezone,
        currency: profile.rows[0].currency,
        tax_percent: Number(profile.rows[0].tax_percent),
        categories: Number(categories.rows[0].n),
        revenue_30d: toRupees(Number(revenue.rows[0].paise)),
        payment,
        recent_orders: recent.rows.map((o) => ({
          number: o.order_no,
          table_number: o.table_number,
          status: o.status,
          payment_status: o.payment_status,
          payment_method: o.payment_method,
          total: toRupees(o.total_paise),
          created_at: o.created_at,
        })),
        activity: activity.rows.map((a) => ({ action: a.action, by: a.actor_email, detail: a.detail ?? {}, at: a.created_at })),
      },
    });
  });

  // The owner types a new password for a restaurant (for one that is locked out). Everyone signed in as it is signed out by the change.
  // A platform owner's own password is changed from Settings, so this can never lock an owner out.
  router.post('/restaurants/:id/password', async (req, res) => {
    const id = restaurantId(req);
    const body = parse(passwordSchema, req.body ?? {});
    const hash = await bcrypt.hash(body.password, 10);
    await db.tx(async (t) => {
      const { rows } = await t.query(`SELECT id, name, email FROM vendors WHERE id = $1 FOR UPDATE`, [id]);
      const target = rows[0];
      if (!target) throw notFound('Restaurant');
      if (isSuperAdminEmail(target.email)) {
        throw conflict('CANNOT_RESET_OWNER', "A platform owner's password is changed in Settings, not from here.");
      }
      await t.query(`UPDATE vendors SET password_hash = $2, password_changed_at = $3 WHERE id = $1`, [target.id, hash, new Date()]);
      await t.query(`UPDATE password_resets SET used_at = now() WHERE vendor_id = $1 AND used_at IS NULL`, [target.id]);
      await audit(t, req, 'set_password', target);
    });
    res.json({ data: { ok: true } });
  });

  // "Log in as": a one-hour login for that restaurant, to see what it sees. The owner's own session is untouched (the admin keeps it
  // aside and offers a way back) and the restaurant's session shows it was opened by the owner. A suspended restaurant cannot be opened.
  router.post('/restaurants/:id/login-as', async (req, res) => {
    const id = restaurantId(req);
    const { rows } = await db.query(`SELECT id, name, email, suspended_at FROM vendors WHERE id = $1`, [id]);
    const target = rows[0];
    if (!target) throw notFound('Restaurant');
    if (isSuperAdminEmail(target.email)) throw conflict('CANNOT_LOGIN_AS_OWNER', "A platform owner's account is opened from its own login.");
    if (target.suspended_at) throw conflict('RESTAURANT_SUSPENDED', 'Reactivate this restaurant first: a suspended restaurant cannot be opened.');
    await audit(db, req, 'login_as', target);
    const expiresIn = 60 * 60;
    res.json({ data: { token: signToken(target.id, { impersonatedBy: req.vendorId, expiresIn }), restaurant: { id: target.id, name: target.name }, expires_in: expiresIn } });
  });

  // Delete a restaurant and everything of it (menu, tables, orders, settings). Only a suspended one, and only when its name is typed.
  router.post('/restaurants/:id/delete', async (req, res) => {
    const id = restaurantId(req);
    const body = parse(deleteSchema, req.body ?? {});
    await db.tx(async (t) => {
      const { rows } = await t.query(`SELECT id, name, email, suspended_at FROM vendors WHERE id = $1 FOR UPDATE`, [id]);
      const target = rows[0];
      if (!target) throw notFound('Restaurant');
      if (target.id === req.vendorId || isSuperAdminEmail(target.email)) {
        throw conflict('CANNOT_DELETE_OWNER', "A platform owner's account can't be deleted.");
      }
      if (!target.suspended_at) throw conflict('SUSPEND_FIRST', 'Suspend this restaurant first. Only a suspended restaurant can be deleted.');
      if (body.confirm_name !== target.name) throw new HttpError(400, 'NAME_MISMATCH', "That is not the restaurant's name. Type it exactly to delete it.");
      const orders = await t.query(`SELECT count(*) AS n FROM orders WHERE vendor_id = $1`, [target.id]);
      await audit(t, req, 'delete', target, { orders: Number(orders.rows[0].n) });
      await t.query(`DELETE FROM vendors WHERE id = $1`, [target.id]);
    });
    res.json({ data: { deleted: true } });
  });

  return router;
}

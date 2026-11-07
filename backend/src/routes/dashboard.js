import { Router } from 'express';
import { toRupees } from '../lib/money.js';

const WEEKLY_DAYS = 7;
const WINDOW_DAYS = 30;

// "Revenue" only ever counts orders that are actually paid, grouped by the day they were paid in the
// vendor's own time zone.
export function dashboardRouter(db) {
  const router = Router();

  router.get('/overview', async (req, res) => {
    const vendorId = req.vendorId;
    const { rows: vendorRows } = await db.query(`SELECT timezone FROM vendors WHERE id = $1`, [vendorId]);
    const tz = vendorRows[0].timezone;

    const [today, live, latest, weekly, methods, top] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(total_paise), 0)::bigint AS n FROM orders
          WHERE vendor_id = $1 AND payment_status = 'paid'
            AND (paid_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
        [vendorId, tz],
      ),
      db.query(`SELECT count(*) AS n FROM orders WHERE vendor_id = $1 AND status IN ('pending', 'accepted')`, [vendorId]),
      db.query(
        `SELECT id, table_number, status, payment_status, total_paise, created_at
           FROM orders WHERE vendor_id = $1 ORDER BY created_at DESC, id DESC LIMIT 3`,
        [vendorId],
      ),
      db.query(
        `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(SUM(o.total_paise), 0)::bigint AS revenue
           FROM generate_series(((now() AT TIME ZONE $2)::date - ${WEEKLY_DAYS - 1})::timestamp,
                                (now() AT TIME ZONE $2)::date::timestamp, interval '1 day') AS d(day)
           LEFT JOIN orders o ON o.vendor_id = $1 AND o.payment_status = 'paid'
                             AND (o.paid_at AT TIME ZONE $2)::date = d.day::date
          GROUP BY d.day ORDER BY d.day`,
        [vendorId, tz],
      ),
      db.query(
        `SELECT payment_method AS method, COALESCE(SUM(total_paise), 0)::bigint AS amount
           FROM orders WHERE vendor_id = $1 AND payment_status = 'paid'
            AND paid_at >= now() - interval '${WINDOW_DAYS} days'
          GROUP BY payment_method`,
        [vendorId],
      ),
      db.query(
        `SELECT oi.name, SUM(oi.quantity)::bigint AS quantity, SUM(oi.line_total_paise)::bigint AS revenue
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.vendor_id = $1 AND o.payment_status = 'paid'
            AND o.paid_at >= now() - interval '${WINDOW_DAYS} days'
          GROUP BY oi.name ORDER BY quantity DESC, revenue DESC LIMIT 5`,
        [vendorId],
      ),
    ]);

    const byMethod = Object.fromEntries(methods.rows.map((r) => [r.method, r.amount]));
    const methodTotal = Object.values(byMethod).reduce((a, b) => a + b, 0);
    const payment_methods = ['cash', 'upi', 'razorpay'].map((method) => ({
      method,
      amount: toRupees(byMethod[method] ?? 0),
      percent: methodTotal ? Math.round(((byMethod[method] ?? 0) / methodTotal) * 100) : 0,
    }));

    res.json({
      data: {
        timezone: tz,
        today_revenue: toRupees(today.rows[0].n),
        live_orders: live.rows[0].n,
        latest_orders: latest.rows.map((o) => ({
          id: o.id,
          table_number: o.table_number,
          status: o.status,
          payment_status: o.payment_status,
          total: toRupees(o.total_paise),
          created_at: o.created_at,
        })),
        weekly_revenue: weekly.rows.map((r) => ({ day: r.day, revenue: toRupees(r.revenue) })),
        payment_methods,
        top_selling: top.rows.map((r) => ({ name: r.name, quantity: r.quantity, revenue: toRupees(r.revenue) })),
        ranges: { weekly_days: WEEKLY_DAYS, payment_days: WINDOW_DAYS, top_days: WINDOW_DAYS },
      },
    });
  });

  return router;
}

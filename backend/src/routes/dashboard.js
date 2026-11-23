import { Router } from 'express';
import { toRupees } from '../lib/money.js';
import { loadOrderItems, photoUrl } from '../lib/serialize.js';

const WEEKLY_DAYS = 7;
const WINDOW_DAYS = 30;
const LATEST = 5;

// "Revenue" only ever counts orders that are actually paid, grouped by the day they were paid in the
// vendor's own time zone.
export function dashboardRouter(db) {
  const router = Router();

  router.get('/overview', async (req, res) => {
    const vendorId = req.vendorId;
    const { rows: vendorRows } = await db.query(`SELECT timezone FROM vendors WHERE id = $1`, [vendorId]);
    const tz = vendorRows[0].timezone;

    const [today, todayOrders, average, live, latest, weekly, methods, top] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(total_paise), 0)::bigint AS n FROM orders
          WHERE vendor_id = $1 AND payment_status = 'paid'
            AND (paid_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
        [vendorId, tz],
      ),
      // Orders placed today (cancelled ones are not counted), in the restaurant's own calendar day.
      db.query(
        `SELECT count(*) AS n FROM orders
          WHERE vendor_id = $1 AND status <> 'cancelled' AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
        [vendorId, tz],
      ),
      // The average paid order over the same window as the payment split and top sellers.
      db.query(
        `SELECT COALESCE(AVG(total_paise), 0)::bigint AS n FROM orders
          WHERE vendor_id = $1 AND payment_status = 'paid' AND paid_at >= now() - interval '${WINDOW_DAYS} days'`,
        [vendorId],
      ),
      db.query(
        `SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
                count(*) FILTER (WHERE status = 'accepted' AND ready_at IS NULL) AS preparing,
                count(*) FILTER (WHERE status = 'accepted' AND ready_at IS NOT NULL) AS ready
           FROM orders WHERE vendor_id = $1`,
        [vendorId],
      ),
      db.query(
        `SELECT id, order_no, table_number, status, payment_status, total_paise, created_at, ready_at
           FROM orders WHERE vendor_id = $1 ORDER BY created_at DESC, id DESC LIMIT ${LATEST}`,
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
      // Grouped by the dish's name (as printed on the order); the photo is that dish's, while it still exists.
      db.query(
        `SELECT t.name, t.quantity, t.revenue, i.id AS dish_id, i.has_photo, i.photo_version
           FROM (SELECT oi.name, MAX(oi.item_id) AS item_id, SUM(oi.quantity)::bigint AS quantity, SUM(oi.line_total_paise)::bigint AS revenue
                   FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE o.vendor_id = $1 AND o.payment_status = 'paid'
                    AND o.paid_at >= now() - interval '${WINDOW_DAYS} days'
                  GROUP BY oi.name ORDER BY quantity DESC, revenue DESC LIMIT 5) t
           LEFT JOIN items i ON i.id = t.item_id
          ORDER BY t.quantity DESC, t.revenue DESC`,
        [vendorId],
      ),
    ]);

    const latestItems = await loadOrderItems(db, latest.rows.map((o) => o.id));
    const liveRow = live.rows[0];

    const byMethod = Object.fromEntries(methods.rows.map((r) => [r.method, r.amount]));
    const methodTotal = Object.values(byMethod).reduce((a, b) => a + b, 0);
    const payment_methods = ['cash', 'upi', 'razorpay', 'cashfree', 'phonepe', 'paytm'].map((method) => ({
      method,
      amount: toRupees(byMethod[method] ?? 0),
      percent: methodTotal ? Math.round(((byMethod[method] ?? 0) / methodTotal) * 100) : 0,
    }));

    res.json({
      data: {
        timezone: tz,
        today_revenue: toRupees(today.rows[0].n),
        today_orders: Number(todayOrders.rows[0].n),
        average_order: toRupees(average.rows[0].n),
        live_orders: Number(liveRow.pending) + Number(liveRow.preparing) + Number(liveRow.ready),
        live_pending: Number(liveRow.pending),
        live_preparing: Number(liveRow.preparing),
        live_ready: Number(liveRow.ready),
        latest_orders: latest.rows.map((o) => ({
          id: o.id,
          number: o.order_no,
          table_number: o.table_number,
          status: o.status,
          payment_status: o.payment_status,
          total: toRupees(o.total_paise),
          created_at: o.created_at,
          ready_at: o.ready_at,
          items: latestItems.get(o.id) ?? [],
        })),
        weekly_revenue: weekly.rows.map((r) => ({ day: r.day, revenue: toRupees(r.revenue) })),
        payment_methods,
        top_selling: top.rows.map((r) => ({
          name: r.name,
          quantity: r.quantity,
          revenue: toRupees(r.revenue),
          photo_url: r.dish_id ? photoUrl({ id: r.dish_id, has_photo: r.has_photo, photo_version: r.photo_version }) : null,
        })),
        ranges: { weekly_days: WEEKLY_DAYS, payment_days: WINDOW_DAYS, top_days: WINDOW_DAYS },
      },
    });
  });

  return router;
}

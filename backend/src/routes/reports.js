import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../lib/errors.js';
import { toCsv } from '../lib/csv.js';
import { toRupees } from '../lib/money.js';
import { writeReportPdf } from '../lib/reportPdf.js';

// Sales reports for the restaurant's accountant. Days are the restaurant's own calendar days (its time zone).
// "Money received" is counted on the day the payment was recorded, exactly like the dashboard; the order list shows every
// order placed OR paid in the period, so each payment can be traced.

const MAX_DAYS = 92;
const MAX_ROWS = 5000;

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-05')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'That date does not exist');

const rangeSchema = z.object({ from: dateString.optional(), to: dateString.optional() });

const METHODS = ['upi', 'cash', 'razorpay', 'cashfree'];

export function reportsRouter(db) {
  const router = Router();

  async function loadReport(vendorId, query) {
    const { from: qFrom, to: qTo } = parse(rangeSchema, query);
    const { rows: v } = await db.query(`SELECT name, timezone FROM vendors WHERE id = $1`, [vendorId]);
    const vendor = v[0];
    const today = (await db.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [vendor.timezone])).rows[0].d;
    const from = qFrom ?? qTo ?? today;
    const to = qTo ?? qFrom ?? today;
    if (to < from) throw new HttpError(400, 'VALIDATION_ERROR', 'to: The end date is before the start date');
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    if (days > MAX_DAYS) throw new HttpError(400, 'VALIDATION_ERROR', `to: Choose at most ${MAX_DAYS} days at a time`);

    const params = [vendorId, from, to, vendor.timezone];
    const { rows } = await db.query(
      `SELECT o.id, o.table_number, o.status, o.payment_status, o.payment_method,
              o.subtotal_paise, o.tax_paise, o.total_paise, o.created_at, o.paid_at,
              ((o.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date) AS placed_in_range,
              (o.payment_status = 'paid' AND (o.paid_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date) AS paid_in_range,
              (SELECT string_agg(oi.quantity::text || ' x ' || oi.name, '; ' ORDER BY oi.id) FROM order_items oi WHERE oi.order_id = o.id) AS items
         FROM orders o
        WHERE o.vendor_id = $1
          AND ((o.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
               OR (o.paid_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date)
        ORDER BY o.created_at, o.id
        LIMIT ${MAX_ROWS + 1}`,
      params,
    );
    if (rows.length > MAX_ROWS) throw new HttpError(400, 'REPORT_TOO_LARGE', `That period has more than ${MAX_ROWS} orders. Choose a shorter one.`);

    const top = await db.query(
      `SELECT oi.name, SUM(oi.quantity)::bigint AS quantity, SUM(oi.line_total_paise)::bigint AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.vendor_id = $1 AND o.payment_status = 'paid' AND (o.paid_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
        GROUP BY oi.name ORDER BY quantity DESC, revenue DESC LIMIT 10`,
      params,
    );

    const orders = rows.map((o) => ({
      id: Number(o.id),
      table_number: o.table_number,
      status: o.status,
      payment_status: o.payment_status,
      payment_method: o.payment_method,
      subtotal: toRupees(o.subtotal_paise),
      tax: toRupees(o.tax_paise),
      total: toRupees(o.total_paise),
      created_at: o.created_at,
      paid_at: o.paid_at,
      items: o.items ?? '',
      placed_in_range: o.placed_in_range,
      paid_in_range: o.paid_in_range,
    }));

    const paid = orders.filter((o) => o.paid_in_range);
    const placed = orders.filter((o) => o.placed_in_range);
    const sum = (list, key) => Math.round(list.reduce((n, o) => n + Math.round(o[key] * 100), 0)) / 100;
    const unpaid = placed.filter((o) => o.payment_status !== 'paid' && o.status !== 'cancelled');
    const summary = {
      sales: {
        orders: paid.length,
        subtotal: sum(paid, 'subtotal'),
        tax: sum(paid, 'tax'),
        total: sum(paid, 'total'),
        by_method: METHODS.map((method) => {
          const list = paid.filter((o) => o.payment_method === method);
          return { method, orders: list.length, amount: sum(list, 'total') };
        }),
      },
      placed: {
        total: placed.length,
        completed: placed.filter((o) => o.status === 'completed').length,
        cancelled: placed.filter((o) => o.status === 'cancelled').length,
        open: placed.filter((o) => o.status === 'pending' || o.status === 'accepted').length,
        unpaid: unpaid.length,
        unpaid_value: sum(unpaid, 'total'),
      },
      top_items: top.rows.map((r) => ({ name: r.name, quantity: Number(r.quantity), revenue: toRupees(Number(r.revenue)) })),
    };
    return { vendor, from, to, summary, orders };
  }

  router.get('/summary', async (req, res) => {
    const { vendor, from, to, summary } = await loadReport(req.vendorId, req.query);
    res.json({ data: { from, to, timezone: vendor.timezone, ...summary } });
  });

  router.get('/orders.csv', async (req, res) => {
    const { vendor, from, to, orders } = await loadReport(req.vendorId, req.query);
    const stamp = (date) =>
      date
        ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: vendor.timezone }).format(new Date(date))
        : '';
    const money = (n) => n.toFixed(2);
    const rows = [
      ['Order no', 'Placed at', 'Paid at', 'Table', 'Status', 'Payment status', 'Payment method', 'Dishes', 'Subtotal', 'Tax', 'Total'],
      ...orders.map((o) => [
        o.id,
        stamp(o.created_at),
        stamp(o.paid_at),
        o.table_number,
        o.status,
        o.payment_status,
        o.payment_method ?? '',
        o.items,
        money(o.subtotal),
        money(o.tax),
        money(o.total),
      ]),
    ];
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="orders-${from}${to === from ? '' : `_to_${to}`}.csv"`,
      'Cache-Control': 'private, no-store',
    });
    res.send(toCsv(rows));
  });

  router.get('/report.pdf', async (req, res) => {
    const report = await loadReport(req.vendorId, req.query);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="sales-report-${report.from}${report.to === report.from ? '' : `_to_${report.to}`}.pdf"`,
      'Cache-Control': 'private, no-store',
    });
    writeReportPdf(res, report);
  });

  return router;
}

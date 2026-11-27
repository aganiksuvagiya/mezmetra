import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError, conflict, notFound, parse } from '../lib/errors.js';
import { decryptSecret } from '../lib/crypto.js';
import { safeEqual } from '../lib/crypto.js';
import { attemptId, GATEWAYS, isRedirectGateway } from '../lib/gateways.js';
import { createRazorpayOrder, createRazorpayQr, fetchRazorpayQr, fetchRazorpayQrPayments, razorpayReady, verifyCheckoutSignature } from '../lib/razorpay.js';
import { toRupees } from '../lib/money.js';
import { itemOut, loadOptionGroups, loadOrderItems, logoUrl, publicOrderOut, themeOut } from '../lib/serialize.js';
import { PAID_ONLINE_SQL } from '../lib/onlinePayments.js';

const QR_TOKEN = /^[a-f0-9]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const orderSchema = z.object({
  items: z
    .array(
      z.object({
        item_id: z.number().int().positive(),
        quantity: z.number().int().min(1, 'Quantity must be at least 1').max(20, 'Maximum 20 of one dish per order'),
        instructions: z.string().trim().max(200).default(''),
        option_ids: z.array(z.number().int().positive()).max(30).default([]),
      }),
    )
    .min(1, 'Your cart is empty')
    .max(40, 'Too many items in one order'),
  note: z.string().trim().max(300).default(''),
  // Optional: when omitted, the first method the restaurant offers is used (counter, then online).
  pay_pref: z.enum(['counter', 'online']).optional(),
  // The 4 digits printed on the table; only checked when the restaurant requires it.
  table_code: z.string().trim().max(10).optional(),
});

const verifySchema = z.object({
  razorpay_order_id: z.string().trim().min(5).max(64),
  razorpay_payment_id: z.string().trim().min(5).max(64),
  razorpay_signature: z.string().trim().min(10).max(200),
});

const idempotencyKey = (req) => {
  const key = req.get('idempotency-key');
  return key && /^[A-Za-z0-9_-]{8,80}$/.test(key) ? key : null;
};

export function publicRouter(db, { orderLimiter }) {
  const router = Router();

  const tableByToken = async (q, token) => {
    if (!QR_TOKEN.test(token)) throw notFound('Table');
    const { rows } = await q.query(
      `SELECT t.*, v.name AS vendor_name, v.currency, v.tax_percent, v.theme_primary, v.theme_accent, v.theme_style, v.has_logo, v.logo_version, v.suspended_at, v.table_code_mode
         FROM dining_tables t JOIN vendors v ON v.id = t.vendor_id
        WHERE t.qr_token = $1`,
      [token],
    );
    if (!rows[0]) throw notFound('Table');
    // A restaurant the platform owner suspended takes no orders, from any of its tables.
    if (rows[0].suspended_at) {
      throw conflict('TABLE_UNAVAILABLE', "This restaurant isn't taking orders right now. Please ask a member of staff.");
    }
    return rows[0];
  };

  const paymentSettings = async (q, vendorId) => {
    const { rows } = await q.query(`SELECT * FROM vendor_payment_settings WHERE vendor_id = $1`, [vendorId]);
    return rows[0];
  };

  // What a diner can use: the restaurant must have switched the method on AND the product must offer it (config.paymentMethods).
  const optionsFrom = (s) => ({
    cash: config.paymentMethods.has('cash') && (s ? s.cash_enabled : true),
    razorpay: config.paymentMethods.has('razorpay') && Boolean(s?.razorpay_enabled) && razorpayReady(s),
    phonepe: config.paymentMethods.has('phonepe') && Boolean(s && GATEWAYS.phonepe.enabled(s) && GATEWAYS.phonepe.configured(s)),
  });

  const paymentOptions = async (q, vendorId) => optionsFrom(await paymentSettings(q, vendorId));

  const orderByToken = async (q, token, { lock = false } = {}) => {
    if (!UUID.test(token)) throw notFound('Order');
    const { rows } = await q.query(`SELECT * FROM orders WHERE public_token = $1${lock ? ' FOR UPDATE' : ''}`, [token.toLowerCase()]);
    if (!rows[0]) throw notFound('Order');
    return rows[0];
  };

  /**
   * Why a diner cannot cancel this order themselves (a sentence for them), or null when they can. It is theirs to cancel only while nothing has
   * happened to it yet: the kitchen has not accepted it, nothing is paid, and no online payment has been opened. Anything else needs a
   * member of staff, who can also refund.
   */
  const cancelBlocker = async (q, order) => {
    if (order.status === 'cancelled') return 'This order is already cancelled.';
    if (order.payment_status !== 'unpaid') return 'This order is already paid. Please ask a member of staff.';
    if (order.status !== 'pending') return 'The kitchen has already started on your order. Please ask a member of staff to cancel it.';
    const started = await q.query(`SELECT 1 FROM payments WHERE order_id = $1 AND status IN ('created', 'paid') LIMIT 1`, [order.id]);
    if (started.rowCount > 0) return 'A payment for this order was started. Please ask a member of staff to cancel it.';
    return null;
  };

  const publicOrder = async (q, order) => {
    const [items, vendor, settings] = await Promise.all([
      loadOrderItems(q, [order.id]),
      q.query(`SELECT id, name, currency, theme_primary, theme_accent, theme_style, has_logo, logo_version FROM vendors WHERE id = $1`, [order.vendor_id]),
      paymentSettings(q, order.vendor_id),
    ]);
    return publicOrderOut(order, items.get(order.id) ?? [], {
      vendor: { name: vendor.rows[0].name, currency: vendor.rows[0].currency, theme: themeOut(vendor.rows[0]), logo_url: logoUrl(vendor.rows[0]) },
      payment_options: optionsFrom(settings),
      can_cancel: (await cancelBlocker(q, order)) === null,
    });
  };

  // --- Menu for one table (what the QR code opens) -----------------------------------------------------------
  router.get('/t/:token', async (req, res) => {
    const table = await tableByToken(db, req.params.token);
    if (!table.is_active) {
      throw conflict('TABLE_UNAVAILABLE', 'This table is not taking orders right now. Please ask a member of staff.');
    }
    // Only active items inside active categories are ever shown to customers.
    const [categories, items, payment] = await Promise.all([
      db.query(
        `SELECT id, name, description FROM categories
          WHERE vendor_id = $1 AND is_active
            AND EXISTS (SELECT 1 FROM items i WHERE i.category_id = categories.id AND i.is_active)
          ORDER BY sort_order, id`,
        [table.vendor_id],
      ),
      db.query(
        `SELECT i.*, c.name AS category_name FROM items i JOIN categories c ON c.id = i.category_id
          WHERE i.vendor_id = $1 AND i.is_active AND c.is_active
          ORDER BY i.is_featured DESC, i.id`,
        [table.vendor_id],
      ),
      paymentOptions(db, table.vendor_id),
    ]);
    const groups = await loadOptionGroups(db, items.rows.map((i) => i.id));
    res.json({
      data: {
        vendor: { name: table.vendor_name, currency: table.currency, tax_percent: Number(table.tax_percent), theme: themeOut(table), logo_url: logoUrl(table, table.vendor_id) },
        table: { number: table.number, code_mode: table.table_code_mode },
        payment_options: payment,
        categories: categories.rows,
        items: items.rows.map((i) => itemOut(i, groups.get(i.id) ?? [])),
      },
    });
  });

  router.get('/vendors/:id/logo', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) throw notFound('Logo');
    const { rows } = await db.query(`SELECT mime, data FROM vendor_logos WHERE vendor_id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound('Logo');
    res.set({
      'Content-Type': rows[0].mime,
      // The URL carries ?v=<logo_version>, so a changed logo always has a new URL.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(Buffer.from(rows[0].data));
  });

  router.get('/items/:id/photo', async (req, res) => {
    const { rows } = await db.query(`SELECT mime, data FROM item_photos WHERE item_id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound('Photo');
    res.set({
      'Content-Type': rows[0].mime,
      // The URL carries ?v=<photo_version>, so a changed photo always has a new URL.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(Buffer.from(rows[0].data));
  });

  // --- Call the waiter / ask for the bill ------------------------------------------------------------------------
  const requestSchema = z.object({ kind: z.enum(['waiter', 'bill']) });

  // Which requests of this table are open, and since when. `*_since` lets each phone tell "the request I made" from one somebody else
  // at this table made (or an old one nobody dealt with), so a newcomer's buttons do not claim the waiter was called for them.
  const openRequests = async (q, tableId) => {
    const { rows } = await q.query(`SELECT kind, created_at FROM service_requests WHERE table_id = $1 AND resolved_at IS NULL`, [tableId]);
    const since = (kind) => {
      const r = rows.find((x) => x.kind === kind);
      return r ? new Date(r.created_at).toISOString() : null;
    };
    return { waiter: since('waiter') !== null, bill: since('bill') !== null, waiter_since: since('waiter'), bill_since: since('bill') };
  };

  // Which requests of this table are open, so the buttons can show "Waiter called" after a reload.
  router.get('/t/:token/requests', async (req, res) => {
    const table = await tableByToken(db, req.params.token);
    res.json({ data: await openRequests(db, table.id) });
  });

  // One open request of each kind per table: tapping again just reports the one already waiting.
  router.post('/t/:token/requests', orderLimiter, async (req, res) => {
    const { kind } = parse(requestSchema, req.body ?? {});
    const table = await tableByToken(db, req.params.token);
    if (!table.is_active) throw conflict('TABLE_UNAVAILABLE', 'This table is not taking requests right now. Please ask a member of staff.');
    const inserted = await db.query(
      `INSERT INTO service_requests (vendor_id, table_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
      [table.vendor_id, table.id, kind],
    );
    res.status(inserted.rows[0] ? 201 : 200).json({ data: { kind, already_asked: !inserted.rows[0], ...(await openRequests(db, table.id)) } });
  });

  // --- Place an order -----------------------------------------------------------------------------------------
  router.post('/t/:token/orders', orderLimiter, async (req, res) => {
    const body = parse(orderSchema, req.body);
    const key = idempotencyKey(req);

    const run = () =>
      db.tx(async (t) => {
        const table = await tableByToken(t, req.params.token);
        if (!table.is_active) {
          throw conflict('TABLE_UNAVAILABLE', 'This table is not taking orders right now. Please ask a member of staff.');
        }

        // Fake-order guard. "required": only someone who can read the code on the table gets to order. "optional": the code may be left
        // out, but one that is typed must be right (and then the order is marked as verified). "off": the code is ignored.
        let codeVerified = false;
        if (table.table_code_mode !== 'off') {
          if (body.table_code) {
            if (!safeEqual(body.table_code, table.code)) {
              throw new HttpError(
                403,
                'TABLE_CODE_WRONG',
                table.table_code_mode === 'optional'
                  ? "That table code isn't right. It is printed on the card on your table. Check it, or clear the box to order without it."
                  : "That table code isn't right. It is printed on the card on your table. Please check it or ask a member of staff.",
              );
            }
            codeVerified = true;
          } else if (table.table_code_mode === 'required') {
            throw new HttpError(403, 'TABLE_CODE_REQUIRED', 'Please enter the table code printed on your table.');
          }
        }

        if (key) {
          const existing = await t.query(`SELECT * FROM orders WHERE table_id = $1 AND idempotency_key = $2`, [table.id, key]);
          if (existing.rows[0]) return { order: existing.rows[0], replay: true };
        }

        // Only a payment method the restaurant currently offers can be chosen (e.g. not "counter" once cash is switched off).
        const offered = optionsFrom(await paymentSettings(t, table.vendor_id));
        const available = [offered.cash && 'counter', (offered.razorpay || offered.phonepe) && 'online'].filter(Boolean);
        if (available.length === 0) {
          throw conflict('PAYMENTS_NOT_SET_UP', "This restaurant hasn't finished setting up payments, so it can't take orders yet. Please ask a member of staff.");
        }
        const payPref = body.pay_pref ?? available[0];
        if (body.pay_pref && !available.includes(body.pay_pref)) {
          throw conflict('PAYMENT_METHOD_UNAVAILABLE', "That way of paying isn't available at this restaurant right now. Please choose another one.");
        }

        // Prices always come from the database, never from the client.
        const ids = [...new Set(body.items.map((i) => i.item_id))];
        const found = await t.query(
          `SELECT i.id, i.name, i.price_paise, i.is_active AND c.is_active AND NOT i.is_sold_out AS available
             FROM items i JOIN categories c ON c.id = i.category_id
            WHERE i.vendor_id = $1 AND i.id = ANY($2::bigint[])`,
          [table.vendor_id, ids],
        );
        const itemById = new Map(found.rows.map((r) => [r.id, r]));
        const unavailable = ids.filter((id) => !itemById.get(id)?.available);
        if (unavailable.length) {
          // Never echo raw ids to a diner: name the dishes we know, and count the ones that were removed.
          const known = unavailable.map((id) => itemById.get(id)?.name).filter(Boolean);
          const removed = unavailable.length - known.length;
          const parts = [...known, ...(removed ? [`${removed} dish${removed > 1 ? 'es' : ''} that ${removed > 1 ? 'were' : 'was'} removed from the menu`] : [])];
          throw conflict('ITEM_UNAVAILABLE', `Some dishes are no longer available: ${parts.join(', ')}. Please update your cart.`);
        }

        const groupsByItem = await loadOptionGroups(t, ids);
        const lines = [];
        let subtotal = 0;
        for (const line of body.items) {
          const item = itemById.get(line.item_id);
          const groups = groupsByItem.get(item.id) ?? [];
          const chosen = [];
          for (const optionId of new Set(line.option_ids)) {
            const group = groups.find((g) => g.options.some((o) => o.id === optionId));
            if (!group) throw new HttpError(400, 'INVALID_OPTION', `Invalid choice for ${item.name}`);
            chosen.push({ group, option: group.options.find((o) => o.id === optionId) });
          }
          for (const group of groups) {
            const count = chosen.filter((c) => c.group.id === group.id).length;
            if (group.required && count === 0) throw new HttpError(400, 'OPTION_REQUIRED', `Choose an option for "${group.name}" on ${item.name}`);
            if (!group.multi_select && count > 1) throw new HttpError(400, 'OPTION_TOO_MANY', `Choose only one option for "${group.name}" on ${item.name}`);
          }
          const optionsPaise = chosen.reduce((n, c) => n + Math.round(c.option.price * 100), 0);
          const unit = item.price_paise + optionsPaise;
          const lineTotal = unit * line.quantity;
          subtotal += lineTotal;
          lines.push({
            item_id: item.id,
            name: item.name,
            unit,
            quantity: line.quantity,
            instructions: line.instructions,
            options: chosen.map((c) => ({ group: c.group.name, name: c.option.name, price_paise: Math.round(c.option.price * 100) })),
            lineTotal,
          });
        }

        const tax = Math.round((subtotal * Number(table.tax_percent)) / 100);
        // The restaurant's own next order number. Updating the vendor row also queues concurrent orders of the same restaurant, so two
        // orders can never get the same number (and a deleted order's number is never handed out again).
        const orderNo = (
          await t.query(`UPDATE vendors SET next_order_no = next_order_no + 1 WHERE id = $1 RETURNING next_order_no - 1 AS n`, [table.vendor_id])
        ).rows[0].n;
        const { rows } = await t.query(
          `INSERT INTO orders (vendor_id, table_id, table_number, idempotency_key, pay_pref, subtotal_paise, tax_paise, total_paise, note, table_code_verified, order_no)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [table.vendor_id, table.id, table.number, key, payPref, subtotal, tax, subtotal + tax, body.note, codeVerified, orderNo],
        );
        for (const l of lines) {
          await t.query(
            `INSERT INTO order_items (order_id, item_id, name, unit_price_paise, quantity, instructions, options, line_total_paise)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
            [rows[0].id, l.item_id, l.name, l.unit, l.quantity, l.instructions, JSON.stringify(l.options), l.lineTotal],
          );
        }
        return { order: rows[0], replay: false };
      });

    let result;
    try {
      result = await run();
    } catch (err) {
      // Two identical submissions raced; the unique index let one win. Return the winner.
      if (err?.code === '23505' && key) result = await run();
      else throw err;
    }
    res.status(result.replay ? 200 : 201).json({ data: await publicOrder(db, result.order) });
  });

  // --- Follow an order ----------------------------------------------------------------------------------------
  router.get('/orders/:token', async (req, res) => {
    res.json({ data: await publicOrder(db, await orderByToken(db, req.params.token)) });
  });

  // --- The diner cancels their own order ---------------------------------------------------------------------
  // Allowed only while cancelBlocker() says nothing has happened to the order yet; asking again for an order that is already cancelled
  // just answers with it. The kitchen sees it turn Cancelled in the admin like any other cancellation.
  router.post('/orders/:token/cancel', orderLimiter, async (req, res) => {
    const order = await db.tx(async (t) => {
      const current = await orderByToken(t, req.params.token, { lock: true });
      if (current.status === 'cancelled') return current;
      const why = await cancelBlocker(t, current);
      if (why) throw conflict('CANNOT_CANCEL', why);
      const { rows } = await t.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1 RETURNING *`, [current.id]);
      return rows[0];
    });
    res.json({ data: await publicOrder(db, order) });
  });

  // --- Online payment (Razorpay) ------------------------------------------------------------------------------
  router.post('/orders/:token/razorpay', orderLimiter, async (req, res) => {
    const order = await orderByToken(db, req.params.token);
    if (order.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'This order was cancelled.');
    if (order.payment_status === 'paid') throw conflict('ALREADY_PAID', 'This order is already paid.');

    const { rows } = await db.query(
      `SELECT s.*, v.name AS vendor_name, v.currency FROM vendor_payment_settings s JOIN vendors v ON v.id = s.vendor_id WHERE s.vendor_id = $1`,
      [order.vendor_id],
    );
    const s = rows[0];
    if (!optionsFrom(s).razorpay) {
      // The message is written for the diner; the restaurant sees the real reason in Payments settings.
      throw conflict('RAZORPAY_NOT_CONFIGURED', 'Online card payment is not available at this restaurant. Please pay another way.');
    }

    const reuse = await db.query(
      `SELECT provider_order_id FROM payments
        WHERE order_id = $1 AND provider = 'razorpay' AND status = 'created' AND amount_paise = $2
        ORDER BY id DESC LIMIT 1`,
      [order.id, order.total_paise],
    );
    let razorpayOrderId = reuse.rows[0]?.provider_order_id;
    if (!razorpayOrderId) {
      const created = await createRazorpayOrder({
        keyId: s.razorpay_key_id,
        keySecret: decryptSecret(s.razorpay_key_secret_enc),
        amountPaise: order.total_paise,
        currency: s.currency,
        receipt: `order_${order.id}`,
        notes: { order_token: order.public_token },
      });
      razorpayOrderId = created.id;
      await db.query(
        `INSERT INTO payments (order_id, provider, provider_order_id, amount_paise, status) VALUES ($1, 'razorpay', $2, $3, 'created')`,
        [order.id, razorpayOrderId, order.total_paise],
      );
    }
    res.json({
      data: {
        key_id: s.razorpay_key_id,
        razorpay_order_id: razorpayOrderId,
        amount_paise: order.total_paise,
        amount: toRupees(order.total_paise),
        currency: s.currency,
        vendor_name: s.vendor_name,
      },
    });
  });

  router.post('/orders/:token/razorpay/verify', orderLimiter, async (req, res) => {
    const body = parse(verifySchema, req.body);
    const order = await db.tx(async (t) => {
      const current = await orderByToken(t, req.params.token, { lock: true });
      if (current.payment_status === 'paid') return current; // already confirmed (e.g. double submit)

      const payment = await t.query(
        `SELECT p.id, s.razorpay_key_id, s.razorpay_key_secret_enc FROM payments p
           JOIN vendor_payment_settings s ON s.vendor_id = $3
          WHERE p.order_id = $1 AND p.provider = 'razorpay' AND p.provider_order_id = $2`,
        [current.id, body.razorpay_order_id, current.vendor_id],
      );
      if (!razorpayReady(payment.rows[0])) {
        throw new HttpError(400, 'PAYMENT_NOT_FOUND', 'We could not match this payment to your order.');
      }
      const valid = verifyCheckoutSignature({
        keySecret: decryptSecret(payment.rows[0].razorpay_key_secret_enc),
        orderId: body.razorpay_order_id,
        paymentId: body.razorpay_payment_id,
        signature: body.razorpay_signature,
      });
      if (!valid) throw new HttpError(400, 'PAYMENT_SIGNATURE_INVALID', 'Payment could not be verified. If money was deducted, show this screen to staff.');

      await t.query(`UPDATE payments SET status = 'paid', provider_payment_id = $2, paid_at = now() WHERE id = $1`, [
        payment.rows[0].id,
        body.razorpay_payment_id,
      ]);
      const { rows } = await t.query(PAID_ONLINE_SQL('razorpay'), [current.id]);
      return rows[0];
    });
    res.json({ data: await publicOrder(db, order) });
  });

  // --- Online payment by scanning a QR code (Razorpay UPI QR) -------------------------------------------------
  // A plain UPI QR cannot tell us it was paid. A Razorpay QR is made for this one order (single use, fixed amount), and the server
  // asks Razorpay whether money arrived on it; only then is the order marked paid (and accepted, like any online payment).
  const QR_LIFETIME_HOURS = 5;
  const razorpayCreds = (s) => ({ keyId: s.razorpay_key_id, keySecret: decryptSecret(s.razorpay_key_secret_enc) });

  router.post('/orders/:token/razorpay-qr', orderLimiter, async (req, res) => {
    const order = await orderByToken(db, req.params.token);
    if (order.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'This order was cancelled.');
    if (order.payment_status === 'paid') throw conflict('ALREADY_PAID', 'This order is already paid.');

    const { rows } = await db.query(
      `SELECT s.*, v.name AS vendor_name FROM vendor_payment_settings s JOIN vendors v ON v.id = s.vendor_id WHERE s.vendor_id = $1`,
      [order.vendor_id],
    );
    const s = rows[0];
    if (!optionsFrom(s).razorpay) {
      throw conflict('RAZORPAY_NOT_CONFIGURED', 'Online payment is not available at this restaurant. Please pay another way.');
    }
    const creds = razorpayCreds(s);

    // One open QR per order and amount, so reopening the page shows the same code.
    const open = await db.query(
      `SELECT provider_order_id FROM payments
        WHERE order_id = $1 AND provider = 'razorpay' AND status = 'created' AND amount_paise = $2
          AND starts_with(provider_order_id, 'qr_') AND created_at > now() - make_interval(hours => $3)
        ORDER BY id DESC LIMIT 1`,
      [order.id, order.total_paise, QR_LIFETIME_HOURS],
    );
    let qr = null;
    try {
      if (open.rows[0]) {
        qr = await fetchRazorpayQr({ ...creds, qrId: open.rows[0].provider_order_id });
        if (qr?.status !== 'active') qr = null; // closed (paid or expired): make a new one
      }
      if (!qr) {
        qr = await createRazorpayQr({
          ...creds,
          amountPaise: order.total_paise,
          name: s.vendor_name.slice(0, 40),
          description: `Table ${order.table_number}`,
          notes: { order_token: order.public_token },
          closeBy: Math.floor(Date.now() / 1000) + QR_LIFETIME_HOURS * 3600 - 60,
        });
        await db.query(`INSERT INTO payments (order_id, provider, provider_order_id, amount_paise, status) VALUES ($1, 'razorpay', $2, $3, 'created')`, [
          order.id,
          qr.id,
          order.total_paise,
        ]);
      }
    } catch (err) {
      // Most often Razorpay has not switched "UPI QR" on for this account. The diner is told to use another way; the real reason is in the log.
      console.warn(`[razorpay-qr] vendor ${order.vendor_id}: ${err.code ?? ''} ${err.message}`);
      throw conflict('RAZORPAY_QR_UNAVAILABLE', 'Scan-to-pay is not available right now. Please tap "Pay online" or pay another way.');
    }
    res.json({ data: { qr_id: qr.id, image_url: qr.image_url, amount: toRupees(order.total_paise), vendor_name: s.vendor_name } });
  });

  // The customer app calls this every few seconds while the QR is on screen. It sends nothing: the server asks Razorpay.
  router.post('/orders/:token/razorpay-qr/verify', orderLimiter, async (req, res) => {
    const order = await orderByToken(db, req.params.token);
    if (order.payment_status !== 'paid') {
      const attempt = (
        await db.query(
          `SELECT id, provider_order_id, amount_paise FROM payments
            WHERE order_id = $1 AND provider = 'razorpay' AND status = 'created' AND starts_with(provider_order_id, 'qr_')
            ORDER BY id DESC LIMIT 1`,
          [order.id],
        )
      ).rows[0];
      const s = attempt && (await paymentSettings(db, order.vendor_id));
      if (attempt && razorpayReady(s)) {
        const list = await fetchRazorpayQrPayments({ ...razorpayCreds(s), qrId: attempt.provider_order_id });
        const hit = (list?.items ?? []).find((p) => p.status === 'captured' && Number(p.amount) === attempt.amount_paise);
        if (hit) {
          await db.tx(async (t) => {
            const current = await orderByToken(t, order.public_token, { lock: true });
            if (current.payment_status === 'paid') return; // a parallel check already recorded it
            await t.query(`UPDATE payments SET status = 'paid', provider_payment_id = $2, paid_at = now() WHERE id = $1`, [attempt.id, hit.id]);
            await t.query(PAID_ONLINE_SQL('razorpay'), [current.id]);
          });
        }
      }
    }
    res.json({ data: await publicOrder(db, await orderByToken(db, req.params.token)) });
  });

  // --- Online payment on the gateway's own page (PhonePe) --------------------------------------------------------
  // The diner is sent to the gateway to pay and comes back to the order page. Whether the money arrived is always decided by the
  // server asking the gateway (with the restaurant's own keys); nothing the browser sends can mark an order paid.
  const gatewayFor = (name) => {
    if (!isRedirectGateway(name)) throw notFound('Payment gateway');
    return GATEWAYS[name];
  };

  const openAttempts = async (q, orderId, provider) =>
    (
      await q.query(
        `SELECT id, provider_order_id, amount_paise FROM payments
          WHERE order_id = $1 AND provider = $2 AND status = 'created' AND created_at > now() - interval '3 hours'
          ORDER BY id DESC LIMIT 5`,
        [orderId, provider],
      )
    ).rows;

  /** Asks the gateway about every open attempt of this order; the first it reports paid marks the order paid. True when the order is paid. */
  const settleAttempts = async (order, provider, settings) => {
    const gateway = GATEWAYS[provider];
    const attempts = await openAttempts(db, order.id, provider);
    if (attempts.length === 0) return false;
    const creds = gateway.creds(settings);
    for (const attempt of attempts) {
      const result = await gateway.status(creds, attempt.provider_order_id);
      if (result.state !== 'paid') continue;
      if (result.amountPaise !== attempt.amount_paise) {
        throw new HttpError(409, 'PAYMENT_AMOUNT_MISMATCH', 'The amount paid does not match this order. Please show this screen to a member of staff.');
      }
      await db.tx(async (t) => {
        const current = await orderByToken(t, order.public_token, { lock: true });
        if (current.payment_status === 'paid') return; // a parallel check already recorded it
        await t.query(`UPDATE payments SET status = 'paid', provider_payment_id = $2, paid_at = now() WHERE id = $1`, [attempt.id, result.paymentId ?? null]);
        await t.query(PAID_ONLINE_SQL(provider), [current.id]);
      });
      return true;
    }
    return false;
  };

  router.post('/orders/:token/pay/:provider', orderLimiter, async (req, res) => {
    const provider = req.params.provider;
    const gateway = gatewayFor(provider);
    const order = await orderByToken(db, req.params.token);
    if (order.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'This order was cancelled.');
    if (order.payment_status === 'paid') throw conflict('ALREADY_PAID', 'This order is already paid.');

    const { rows } = await db.query(
      `SELECT s.*, v.name AS vendor_name FROM vendor_payment_settings s JOIN vendors v ON v.id = s.vendor_id WHERE s.vendor_id = $1`,
      [order.vendor_id],
    );
    const settings = rows[0];
    if (!optionsFrom(settings)[provider]) {
      // The message is written for the diner; the restaurant sees the real reason in Payments settings.
      throw conflict('GATEWAY_NOT_CONFIGURED', 'Online payment is not available at this restaurant. Please pay another way.');
    }
    // A payment the diner already made must never be asked for twice: look at the earlier attempts first.
    if (await settleAttempts(order, provider, settings)) throw conflict('ALREADY_PAID', 'This order is already paid.');
    await db.query(
      `UPDATE payments SET status = 'failed' WHERE order_id = $1 AND provider = $2 AND status = 'created' AND created_at <= now() - interval '3 hours'`,
      [order.id, provider],
    );

    const providerOrderId = attemptId(order.id);
    const client = await gateway.start(gateway.creds(settings), {
      providerOrderId,
      order,
      returnUrl: `${config.customerAppUrl}/o/${order.public_token}`,
    });
    await db.query(`INSERT INTO payments (order_id, provider, provider_order_id, amount_paise, status) VALUES ($1, $2, $3, $4, 'created')`, [
      order.id,
      provider,
      providerOrderId,
      order.total_paise,
    ]);
    res.json({ data: { provider, client, amount: toRupees(order.total_paise), vendor_name: settings.vendor_name } });
  });

  // The order page calls this when the diner comes back from the gateway (and whenever the page is opened again), so a payment is
  // picked up even if the browser was closed in between. It sends nothing: the server asks the gateway.
  router.post('/orders/:token/pay/:provider/verify', orderLimiter, async (req, res) => {
    const provider = req.params.provider;
    const gateway = gatewayFor(provider);
    const order = await orderByToken(db, req.params.token);
    if (order.payment_status !== 'paid') {
      const settings = await paymentSettings(db, order.vendor_id);
      if (settings && gateway.configured(settings)) await settleAttempts(order, provider, settings);
    }
    res.json({ data: await publicOrder(db, await orderByToken(db, req.params.token)) });
  });

  return router;
}

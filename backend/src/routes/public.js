import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError, conflict, notFound, parse } from '../lib/errors.js';
import { decryptSecret } from '../lib/crypto.js';
import { createRazorpayOrder, verifyCheckoutSignature } from '../lib/razorpay.js';
import { toRupees } from '../lib/money.js';
import { UPI_REFERENCE_RE, upiQuery } from '../lib/upi.js';
import { itemOut, loadOptionGroups, loadOrderItems, publicOrderOut, themeOut } from '../lib/serialize.js';

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
  // Optional: when omitted, the first method the restaurant offers is used (counter, then UPI, then online).
  pay_pref: z.enum(['counter', 'online', 'upi']).optional(),
});

const claimSchema = z.object({
  // The UPI transaction / reference number shown by the diner's app. Optional, but it makes staff confirmation easy.
  reference: z.union([z.literal(''), z.string().trim().regex(UPI_REFERENCE_RE, 'The reference should be 6-30 letters or digits')]).optional(),
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
      `SELECT t.*, v.name AS vendor_name, v.currency, v.tax_percent, v.theme_primary, v.theme_accent, v.suspended_at
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
    razorpay: config.paymentMethods.has('razorpay') && Boolean(s && s.razorpay_enabled && s.razorpay_key_id && s.razorpay_key_secret_enc),
    // UPI works with a UPI ID (pay buttons and QR) and/or a mobile number (diners send money to it themselves).
    upi: config.paymentMethods.has('upi') && Boolean(s && s.upi_enabled && (s.upi_id || s.upi_mobile)),
  });

  const paymentOptions = async (q, vendorId) => optionsFrom(await paymentSettings(q, vendorId));

  const orderByToken = async (q, token, { lock = false } = {}) => {
    if (!UUID.test(token)) throw notFound('Order');
    const { rows } = await q.query(`SELECT * FROM orders WHERE public_token = $1${lock ? ' FOR UPDATE' : ''}`, [token.toLowerCase()]);
    if (!rows[0]) throw notFound('Order');
    return rows[0];
  };

  const publicOrder = async (q, order) => {
    const [items, vendor, settings] = await Promise.all([
      loadOrderItems(q, [order.id]),
      q.query(`SELECT name, currency, theme_primary, theme_accent FROM vendors WHERE id = $1`, [order.vendor_id]),
      paymentSettings(q, order.vendor_id),
    ]);
    const options = optionsFrom(settings);
    // Everything a UPI app needs to open with the amount filled in. Built here so the amount cannot be tampered with.
    const payable = options.upi && order.payment_status === 'unpaid' && order.status !== 'cancelled';
    return publicOrderOut(order, items.get(order.id) ?? [], {
      vendor: { name: vendor.rows[0].name, currency: vendor.rows[0].currency, theme: themeOut(vendor.rows[0]) },
      payment_options: options,
      upi: payable
        ? {
            vpa: settings.upi_id ?? null,
            mobile: settings.upi_mobile ?? null,
            // Whether to show the Google Pay / PhonePe / Paytm buttons (off for a personal UPI ID: the apps refuse such links).
            pay_buttons: Boolean(settings.upi_pay_buttons && settings.upi_id),
            payee_name: vendor.rows[0].name,
            amount: toRupees(order.total_paise),
            // Without a UPI ID there is no pay link: the diner pays the mobile number by hand.
            query: settings.upi_id
              ? upiQuery({
                  vpa: settings.upi_id,
                  payeeName: vendor.rows[0].name,
                  amountPaise: order.total_paise,
                  note: `Table ${order.table_number} order`,
                })
              : null,
          }
        : null,
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
        vendor: { name: table.vendor_name, currency: table.currency, tax_percent: Number(table.tax_percent), theme: themeOut(table) },
        table: { number: table.number },
        payment_options: payment,
        categories: categories.rows,
        items: items.rows.map((i) => itemOut(i, groups.get(i.id) ?? [])),
      },
    });
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

        if (key) {
          const existing = await t.query(`SELECT * FROM orders WHERE table_id = $1 AND idempotency_key = $2`, [table.id, key]);
          if (existing.rows[0]) return { order: existing.rows[0], replay: true };
        }

        // Only a payment method the restaurant currently offers can be chosen (e.g. not "counter" once cash is switched off).
        const offered = optionsFrom(await paymentSettings(t, table.vendor_id));
        const available = [offered.cash && 'counter', offered.upi && 'upi', offered.razorpay && 'online'].filter(Boolean);
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
        const { rows } = await t.query(
          `INSERT INTO orders (vendor_id, table_id, table_number, idempotency_key, pay_pref, subtotal_paise, tax_paise, total_paise, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [table.vendor_id, table.id, table.number, key, payPref, subtotal, tax, subtotal + tax, body.note],
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

  // --- UPI app payment: the diner says they paid, staff confirm in the admin panel ---------------------------
  // A plain UPI link cannot tell us whether the payment went through, so this never marks the order paid.
  router.post('/orders/:token/upi-claim', orderLimiter, async (req, res) => {
    const body = parse(claimSchema, req.body ?? {});
    const order = await db.tx(async (t) => {
      const current = await orderByToken(t, req.params.token, { lock: true });
      if (current.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'This order was cancelled.');
      if (current.payment_status === 'paid') return current;
      if (!optionsFrom(await paymentSettings(t, current.vendor_id)).upi) {
        throw conflict('UPI_NOT_AVAILABLE', 'UPI payment is not available at this restaurant. Please pay at the counter.');
      }
      const { rows } = await t.query(
        `UPDATE orders SET claim_reference = $2, claimed_at = now() WHERE id = $1 RETURNING *`,
        [current.id, body.reference || null],
      );
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
        `SELECT p.id, s.razorpay_key_secret_enc FROM payments p
           JOIN vendor_payment_settings s ON s.vendor_id = $3
          WHERE p.order_id = $1 AND p.provider = 'razorpay' AND p.provider_order_id = $2`,
        [current.id, body.razorpay_order_id, current.vendor_id],
      );
      if (!payment.rows[0] || !payment.rows[0].razorpay_key_secret_enc) {
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
      const { rows } = await t.query(
        `UPDATE orders SET payment_status = 'paid', payment_method = 'razorpay', paid_at = now() WHERE id = $1 RETURNING *`,
        [current.id],
      );
      return rows[0];
    });
    res.json({ data: await publicOrder(db, order) });
  });

  return router;
}

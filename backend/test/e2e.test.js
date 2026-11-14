// End-to-end API tests against an in-memory PGlite database (same SQL as production Postgres).
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
// The product defaults to UPI only; these tests exercise every method, and the "only UPI" suite below switches it back.
process.env.PAYMENT_METHODS = 'upi,cash,razorpay,cashfree';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

const { config } = await import('../src/config.js');
const { createDb } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { csvCell, toCsv } = await import('../src/lib/csv.js');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let db;
let server;
let base;
let mockRazorpay;
const sentMail = [];
const fakeMailer = { configured: true, send: async (message) => void sentMail.push(message) };
const razorpayCalls = [];
const razorpayRefunds = []; // refunds the fake Razorpay was asked for
const qrCodes = new Map(); // fake Razorpay QR code id -> { status, payments: [] }

async function listen(app) {
  return new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function api(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: payload, headers: res.headers };
}

before(async () => {
  db = await createDb({ pgliteDir: 'memory' });
  await migrate(db, { log: () => {} });
  server = await listen(createApp({ db, rateLimits: false, mailer: fakeMailer }));
  base = `http://127.0.0.1:${server.address().port}`;

  // A fake Razorpay API so the payment flow can be tested without real keys.
  mockRazorpay = await new Promise((resolve) => {
    const s = http
      .createServer((req, res) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => {
          razorpayCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: data ? JSON.parse(data) : null });
          const ok = req.headers.authorization === `Basic ${Buffer.from('rzp_test_abcdef123456:secret-value-123').toString('base64')}`;
          res.setHeader('Content-Type', 'application/json');
          if (!ok) {
            res.statusCode = 401;
            return res.end(JSON.stringify({ error: { description: 'Authentication failed' } }));
          }
          const path = req.url.split('?')[0];
          if (req.method === 'POST' && path === '/v1/payments/qr_codes') {
            const id = `qr_MOCK${String(qrCodes.size + 1).padStart(4, '0')}`;
            qrCodes.set(id, { status: 'active', payments: [] });
            return res.end(JSON.stringify({ id, entity: 'qr_code', status: 'active', image_url: `https://rzp.test/${id}.png`, payment_amount: JSON.parse(data).payment_amount }));
          }
          const refund = path.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)\/refund$/);
          if (req.method === 'POST' && refund) {
            razorpayRefunds.push({ payment: refund[1], amount: JSON.parse(data).amount });
            return res.end(JSON.stringify({ id: `rfnd_MOCK${razorpayRefunds.length}`, entity: 'refund', payment_id: refund[1], status: 'processed' }));
          }
          const qr = path.match(/^\/v1\/payments\/qr_codes\/(qr_[A-Za-z0-9]+)(\/payments)?$/);
          if (qr) {
            const found = qrCodes.get(qr[1]);
            if (!found) {
              res.statusCode = 404;
              return res.end(JSON.stringify({ error: { description: 'No db records found.' } }));
            }
            if (qr[2]) return res.end(JSON.stringify({ entity: 'collection', count: found.payments.length, items: found.payments }));
            return res.end(JSON.stringify({ id: qr[1], entity: 'qr_code', status: found.status, image_url: `https://rzp.test/${qr[1]}.png` }));
          }
          res.end(JSON.stringify({ id: 'order_MOCK123456', entity: 'order', items: [] }));
        });
      })
      .listen(0, '127.0.0.1', () => resolve(s));
  });
  config.razorpayApiBase = `http://127.0.0.1:${mockRazorpay.address().port}/v1`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => mockRazorpay.close(r));
  await db.close();
});

// Shared state across the ordered tests below.
const s = {};

describe('auth', () => {
  it('health check reports the database', async () => {
    const r = await api('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'ok');
  });

  it('signs up, rejects weak passwords and duplicate emails', async () => {
    const weak = await api('POST', '/api/auth/signup', { body: { name: 'Spice Hub', email: 'owner@spice.test', password: 'short' } });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, 'VALIDATION_ERROR');

    const ok = await api('POST', '/api/auth/signup', { body: { name: 'Spice Hub', email: 'Owner@Spice.test', password: 'a-long-enough-password' } });
    assert.equal(ok.status, 201);
    assert.ok(ok.body.data.token);
    assert.equal(ok.body.data.vendor.email, 'owner@spice.test');
    assert.equal(ok.body.data.vendor.password_hash, undefined);
    s.token = ok.body.data.token;

    const dup = await api('POST', '/api/auth/signup', { body: { name: 'Other', email: 'owner@spice.test', password: 'another-long-password' } });
    assert.equal(dup.status, 409);
  });

  it('logs in with the right password only', async () => {
    const bad = await api('POST', '/api/auth/login', { body: { email: 'owner@spice.test', password: 'wrong-password-1' } });
    assert.equal(bad.status, 401);
    const good = await api('POST', '/api/auth/login', { body: { email: 'owner@spice.test', password: 'a-long-enough-password' } });
    assert.equal(good.status, 200);
    const me = await api('GET', '/api/auth/me', { token: good.body.data.token });
    assert.equal(me.body.data.name, 'Spice Hub');
  });

  it('protects admin routes', async () => {
    assert.equal((await api('GET', '/api/admin/categories')).status, 401);
    assert.equal((await api('GET', '/api/admin/categories', { token: 'garbage' })).status, 401);
  });
});

describe('menu management', () => {
  it('creates categories and edits only the fields sent', async () => {
    const pizza = await api('POST', '/api/admin/categories', { token: s.token, body: { name: 'Pizza', description: 'Hot and fresh' } });
    assert.equal(pizza.status, 201);
    s.pizzaId = pizza.body.data.id;
    const drinks = await api('POST', '/api/admin/categories', { token: s.token, body: { name: 'Drinks (hidden)', is_active: false } });
    s.hiddenCatId = drinks.body.data.id;
    const dupe = await api('POST', '/api/admin/categories', { token: s.token, body: { name: 'pizza' } });
    assert.equal(dupe.status, 409);

    const patched = await api('PATCH', `/api/admin/categories/${s.pizzaId}`, { token: s.token, body: { name: 'Pizzas' } });
    assert.equal(patched.body.data.name, 'Pizzas');
    assert.equal(patched.body.data.description, 'Hot and fresh', 'description must survive a name-only edit');
    assert.equal(patched.body.data.is_active, true);
  });

  it('creates items with option groups and computes price in paise', async () => {
    const item = await api('POST', '/api/admin/items', {
      token: s.token,
      body: {
        category_id: s.pizzaId,
        name: 'Margherita',
        description: 'Classic',
        price: 499.5,
        option_groups: [
          { name: 'Size', required: true, multi_select: false, options: [{ name: 'Regular', price: 0 }, { name: 'Large', price: 150 }] },
          { name: 'Extras', multi_select: true, options: [{ name: 'Cheese', price: 60 }, { name: 'Olives', price: 40 }] },
        ],
      },
    });
    assert.equal(item.status, 201);
    assert.equal(item.body.data.price, 499.5);
    assert.equal(item.body.data.option_groups.length, 2);
    s.pizzaItem = item.body.data;

    const hidden = await api('POST', '/api/admin/items', { token: s.token, body: { category_id: s.pizzaId, name: 'Secret special', price: 100, is_active: false } });
    s.hiddenItemId = hidden.body.data.id;
    const inHiddenCat = await api('POST', '/api/admin/items', { token: s.token, body: { category_id: s.hiddenCatId, name: 'Cola', price: 50 } });
    s.colaId = inHiddenCat.body.data.id;

    const badPrice = await api('POST', '/api/admin/items', { token: s.token, body: { category_id: s.pizzaId, name: 'Bad', price: -5 } });
    assert.equal(badPrice.status, 400);
  });

  it('refuses to delete a category that still has items', async () => {
    const r = await api('DELETE', `/api/admin/categories/${s.pizzaId}`, { token: s.token });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CATEGORY_NOT_EMPTY');
  });

  it('stores an item photo and serves it publicly with caching', async () => {
    const bad = await api('PUT', `/api/admin/items/${s.pizzaItem.id}/photo`, { token: s.token, raw: Buffer.from('not an image'), headers: { 'Content-Type': 'image/png' } });
    assert.equal(bad.status, 415);

    const up = await api('PUT', `/api/admin/items/${s.pizzaItem.id}/photo`, { token: s.token, raw: PNG_1X1, headers: { 'Content-Type': 'image/png' } });
    assert.equal(up.status, 200);
    assert.match(up.body.data.photo_url, /^\/api\/public\/items\/\d+\/photo\?v=1$/);

    const photo = await api('GET', up.body.data.photo_url);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.match(photo.headers.get('cache-control'), /immutable/);
    assert.ok(photo.body.equals(PNG_1X1));
  });

  it('keeps vendors isolated from each other', async () => {
    const other = await api('POST', '/api/auth/signup', { body: { name: 'Other Cafe', email: 'cafe@other.test', password: 'another-long-password' } });
    s.otherToken = other.body.data.token;
    assert.equal((await api('GET', `/api/admin/categories/${s.pizzaId}`, { token: s.otherToken })).status, 404);
    assert.equal((await api('PATCH', `/api/admin/items/${s.pizzaItem.id}`, { token: s.otherToken, body: { name: 'hacked' } })).status, 404);
    assert.equal((await api('DELETE', `/api/admin/items/${s.pizzaItem.id}`, { token: s.otherToken })).status, 404);
    const cross = await api('POST', '/api/admin/items', { token: s.otherToken, body: { category_id: s.pizzaId, name: 'Steal', price: 1 } });
    assert.equal(cross.status, 400, 'cannot attach an item to another vendor\'s category');
    const list = await api('GET', '/api/admin/items', { token: s.otherToken });
    assert.equal(list.body.data.length, 0);
  });
});

describe('tables and QR codes', () => {
  it('creates tables with an unguessable QR link', async () => {
    const t = await api('POST', '/api/admin/tables', { token: s.token, body: { number: 'T-01', capacity: 4, area: 'Indoor' } });
    assert.equal(t.status, 201);
    s.table = t.body.data;
    assert.match(s.table.qr_url, new RegExp(`^${config.customerAppUrl}/t/[a-f0-9]{32}$`));
    assert.ok(!s.table.qr_url.includes('@'), 'QR must not leak the vendor email');
    s.qrToken = s.table.qr_url.split('/t/')[1];
    assert.equal(s.table.availability, 'available');

    const dup = await api('POST', '/api/admin/tables', { token: s.token, body: { number: 't-01', capacity: 2 } });
    assert.equal(dup.status, 409);
  });

  it('editing capacity does not re-activate an inactive table', async () => {
    const t2 = await api('POST', '/api/admin/tables', { token: s.token, body: { number: 'T-02', capacity: 2, is_active: false } });
    assert.equal(t2.body.data.availability, 'maintenance');
    const edited = await api('PATCH', `/api/admin/tables/${t2.body.data.id}`, { token: s.token, body: { capacity: 3 } });
    assert.equal(edited.body.data.capacity, 3);
    assert.equal(edited.body.data.is_active, false);
    s.inactiveTable = t2.body.data;
  });

  it('renders a QR PNG for the admin', async () => {
    const png = await api('GET', `/api/admin/tables/${s.table.id}/qr.png?size=256`, { token: s.token });
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.body.subarray(1, 4).toString(), 'PNG');
    assert.equal((await api('GET', `/api/admin/tables/${s.table.id}/qr.png`)).status, 401);
  });
});

describe('customer menu', () => {
  it('only shows active items in active categories', async () => {
    const r = await api('GET', `/api/public/t/${s.qrToken}`);
    assert.equal(r.status, 200);
    const names = r.body.data.items.map((i) => i.name);
    assert.deepEqual(names, ['Margherita']);
    assert.deepEqual(r.body.data.categories.map((c) => c.name), ['Pizzas']);
    assert.equal(r.body.data.table.number, 'T-01');
    assert.equal(r.body.data.payment_options.razorpay, false);
  });

  it('rejects unknown and inactive tables', async () => {
    assert.equal((await api('GET', `/api/public/t/${'0'.repeat(32)}`)).status, 404);
    assert.equal((await api('GET', '/api/public/t/not-a-token')).status, 404);
    const token = s.inactiveTable.qr_url.split('/t/')[1];
    const r = await api('GET', `/api/public/t/${token}`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'TABLE_UNAVAILABLE');
  });
});

describe('ordering', () => {
  const sizeOf = (name) => s.pizzaItem.option_groups.find((g) => g.name === 'Size').options.find((o) => o.name === name).id;
  const extra = (name) => s.pizzaItem.option_groups.find((g) => g.name === 'Extras').options.find((o) => o.name === name).id;

  it('validates the cart and required options', async () => {
    const path = `/api/public/t/${s.qrToken}/orders`;
    assert.equal((await api('POST', path, { body: { items: [] } })).status, 400);
    const noSize = await api('POST', path, { body: { items: [{ item_id: s.pizzaItem.id, quantity: 1 }] } });
    assert.equal(noSize.status, 400);
    assert.equal(noSize.body.error.code, 'OPTION_REQUIRED');
    const twoSizes = await api('POST', path, { body: { items: [{ item_id: s.pizzaItem.id, quantity: 1, option_ids: [sizeOf('Regular'), sizeOf('Large')] }] } });
    assert.equal(twoSizes.body.error.code, 'OPTION_TOO_MANY');
    const hiddenItem = await api('POST', path, { body: { items: [{ item_id: s.hiddenItemId, quantity: 1 }] } });
    assert.equal(hiddenItem.status, 409);
    assert.equal(hiddenItem.body.error.code, 'ITEM_UNAVAILABLE');
    const hiddenCat = await api('POST', path, { body: { items: [{ item_id: s.colaId, quantity: 1 }] } });
    assert.equal(hiddenCat.body.error.code, 'ITEM_UNAVAILABLE');
  });

  it('prices the order on the server and ignores client prices', async () => {
    const r = await api('POST', `/api/public/t/${s.qrToken}/orders`, {
      headers: { 'Idempotency-Key': 'test-checkout-0001' },
      body: {
        // A tampered price/total from the client must be ignored.
        total: 1,
        items: [{ item_id: s.pizzaItem.id, price: 1, quantity: 2, instructions: 'less spicy', option_ids: [sizeOf('Large'), extra('Cheese')] }],
        note: 'Birthday table',
      },
    });
    assert.equal(r.status, 201);
    // (499.50 + 150 + 60) * 2 = 1419.00
    assert.equal(r.body.data.total, 1419);
    assert.equal(r.body.data.status, 'pending');
    assert.equal(r.body.data.payment_status, 'unpaid');
    assert.equal(r.body.data.id, undefined, 'numeric order id is not exposed to customers');
    assert.match(r.body.data.token, /^[0-9a-f-]{36}$/);
    assert.equal(r.body.data.items[0].options.length, 2);
    s.orderToken = r.body.data.token;
  });

  it('is idempotent: the same checkout key returns the same order', async () => {
    const body = { items: [{ item_id: s.pizzaItem.id, quantity: 2, option_ids: [sizeOf('Large'), extra('Cheese')] }] };
    const again = await api('POST', `/api/public/t/${s.qrToken}/orders`, { headers: { 'Idempotency-Key': 'test-checkout-0001' }, body });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.token, s.orderToken);
    const list = await api('GET', '/api/admin/orders', { token: s.token });
    assert.equal(list.body.meta.total, 1);
  });

  it('shows the order to the admin and marks the table occupied', async () => {
    const list = await api('GET', '/api/admin/orders?status=active', { token: s.token });
    assert.equal(list.body.data.length, 1);
    s.orderId = list.body.data[0].id;
    assert.equal(list.body.data[0].table_number, 'T-01');
    assert.equal(list.body.data[0].total_quantity, 2);
    const tables = await api('GET', '/api/admin/tables', { token: s.token });
    assert.equal(tables.body.data.find((t) => t.number === 'T-01').availability, 'occupied');
    const search = await api('GET', `/api/admin/orders?q=${s.orderId}`, { token: s.token });
    assert.equal(search.body.data.length, 1);
    assert.equal((await api('GET', '/api/admin/orders?q=T-99', { token: s.token })).body.data.length, 0);
  });

  it('follows the order lifecycle and does not allow skipping payment', async () => {
    const early = await api('PATCH', `/api/admin/orders/${s.orderId}/status`, { token: s.token, body: { status: 'completed' } });
    assert.equal(early.status, 409, 'pending orders cannot jump straight to completed');

    const accepted = await api('PATCH', `/api/admin/orders/${s.orderId}/status`, { token: s.token, body: { status: 'accepted' } });
    assert.equal(accepted.body.data.status, 'accepted');

    const unpaid = await api('PATCH', `/api/admin/orders/${s.orderId}/status`, { token: s.token, body: { status: 'completed' } });
    assert.equal(unpaid.status, 409);
    assert.equal(unpaid.body.error.code, 'PAYMENT_REQUIRED');

    const noReceipt = await api('GET', `/api/admin/orders/${s.orderId}/receipt.pdf`, { token: s.token });
    assert.equal(noReceipt.status, 409);

    const paid = await api('POST', `/api/admin/orders/${s.orderId}/cash-payment`, { token: s.token });
    assert.equal(paid.body.data.payment_status, 'paid');
    assert.equal(paid.body.data.payment_method, 'cash');
    assert.equal((await api('POST', `/api/admin/orders/${s.orderId}/cash-payment`, { token: s.token })).status, 409);

    const done = await api('PATCH', `/api/admin/orders/${s.orderId}/status`, { token: s.token, body: { status: 'completed' } });
    assert.equal(done.body.data.status, 'completed');
    assert.equal((await api('PATCH', `/api/admin/orders/${s.orderId}/status`, { token: s.token, body: { status: 'cancelled' } })).status, 409);
  });

  it('generates a PDF receipt on demand', async () => {
    const r = await api('GET', `/api/admin/orders/${s.orderId}/receipt.pdf`, { token: s.token });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.body.subarray(0, 4).toString(), '%PDF');
    assert.ok(r.body.length > 1000);
  });

  it('frees the table once the order is completed', async () => {
    const tables = await api('GET', '/api/admin/tables', { token: s.token });
    assert.equal(tables.body.data.find((t) => t.number === 'T-01').availability, 'available');
  });

  it('counts only paid orders in dashboard revenue and reports dish revenue', async () => {
    // An unpaid second order must not show up as revenue.
    const second = await api('POST', `/api/public/t/${s.qrToken}/orders`, {
      body: { items: [{ item_id: s.pizzaItem.id, quantity: 1, option_ids: [sizeOf('Regular')] }] },
    });
    assert.equal(second.status, 201);

    const d = await api('GET', '/api/admin/dashboard/overview', { token: s.token });
    assert.equal(d.status, 200);
    assert.equal(d.body.data.today_revenue, 1419);
    assert.equal(d.body.data.live_orders, 1);
    assert.equal(d.body.data.weekly_revenue.length, 7);
    assert.equal(d.body.data.weekly_revenue.at(-1).revenue, 1419);
    const cash = d.body.data.payment_methods.find((m) => m.method === 'cash');
    assert.deepEqual([cash.amount, cash.percent], [1419, 100]);
    assert.deepEqual(d.body.data.top_selling[0], { name: 'Margherita', quantity: 2, revenue: 1419 });
    s.secondOrderToken = second.body.data.token;
  });
});

describe('online payments (Razorpay)', () => {
  it('tells the diner to pay at the counter when the vendor has no keys', async () => {
    const r = await api('POST', `/api/public/orders/${s.secondOrderToken}/razorpay`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'RAZORPAY_NOT_CONFIGURED');
  });

  it('validates and stores vendor keys without ever returning the secret', async () => {
    const badKey = await api('PUT', '/api/admin/payment-settings', { token: s.token, body: { razorpay_key_id: 'nope', razorpay_key_secret: 'secret-value-123' } });
    assert.equal(badKey.status, 400);
    const noKeys = await api('PUT', '/api/admin/payment-settings', { token: s.token, body: { razorpay_enabled: true } });
    assert.equal(noKeys.status, 400);

    const wrong = await api('PUT', '/api/admin/payment-settings', {
      token: s.token,
      body: { razorpay_enabled: true, razorpay_key_id: 'rzp_test_wrongkey1234', razorpay_key_secret: 'wrong-secret-1' },
    });
    assert.equal(wrong.status, 200);
    const failing = await api('POST', '/api/admin/payment-settings/test', { token: s.token });
    assert.equal(failing.status, 502);
    assert.equal(failing.body.error.code, 'RAZORPAY_BAD_KEYS');

    const saved = await api('PUT', '/api/admin/payment-settings', {
      token: s.token,
      body: { razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' },
    });
    assert.equal(saved.body.data.razorpay_configured, true);
    assert.equal(saved.body.data.razorpay_mode, 'test');
    assert.ok(!JSON.stringify(saved.body).includes('secret-value-123'));
    const stored = await db.query(`SELECT razorpay_key_secret_enc FROM vendor_payment_settings`);
    assert.ok(stored.rows.every((row) => !String(row.razorpay_key_secret_enc ?? '').includes('secret-value-123')), 'secret is encrypted at rest');
    assert.equal((await api('POST', '/api/admin/payment-settings/test', { token: s.token })).body.data.ok, true);

    const menu = await api('GET', `/api/public/t/${s.qrToken}`);
    assert.equal(menu.body.data.payment_options.razorpay, true);
  });

  it('creates one Razorpay order (reused on retry) and verifies the signature', async () => {
    const callsBefore = razorpayCalls.filter((c) => c.method === 'POST').length;
    const a = await api('POST', `/api/public/orders/${s.secondOrderToken}/razorpay`);
    assert.equal(a.status, 200);
    assert.equal(a.body.data.razorpay_order_id, 'order_MOCK123456');
    assert.equal(a.body.data.key_id, 'rzp_test_abcdef123456');
    assert.equal(a.body.data.amount_paise, 49950);
    const b = await api('POST', `/api/public/orders/${s.secondOrderToken}/razorpay`);
    assert.equal(b.body.data.razorpay_order_id, a.body.data.razorpay_order_id);
    const created = razorpayCalls.filter((c) => c.method === 'POST').slice(callsBefore);
    assert.equal(created.length, 1, 'retrying must not create a second Razorpay order');
    assert.equal(created[0].body.amount, 49950);
    assert.equal(created[0].body.currency, 'INR');

    const orderId = a.body.data.razorpay_order_id;
    const bad = await api('POST', `/api/public/orders/${s.secondOrderToken}/razorpay/verify`, {
      body: { razorpay_order_id: orderId, razorpay_payment_id: 'pay_TESTPAY0001', razorpay_signature: 'f'.repeat(64) },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'PAYMENT_SIGNATURE_INVALID');
    assert.equal((await api('GET', `/api/public/orders/${s.secondOrderToken}`)).body.data.payment_status, 'unpaid');

    const signature = createHmac('sha256', 'secret-value-123').update(`${orderId}|pay_TESTPAY0001`).digest('hex');
    const ok = await api('POST', `/api/public/orders/${s.secondOrderToken}/razorpay/verify`, {
      body: { razorpay_order_id: orderId, razorpay_payment_id: 'pay_TESTPAY0001', razorpay_signature: signature },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.payment_status, 'paid');
    assert.equal(ok.body.data.payment_method, 'razorpay');
    assert.equal(ok.body.data.status, 'accepted', 'paying online accepts the order: staff need not press Accept');
    assert.ok(ok.body.data.accepted_at, 'with a time');

    // Verifying again (double submit) is harmless; paying an already paid order is refused.
    assert.equal((await api('POST', `/api/public/orders/${s.secondOrderToken}/razorpay/verify`, {
      body: { razorpay_order_id: orderId, razorpay_payment_id: 'pay_TESTPAY0001', razorpay_signature: signature },
    })).status, 200);
    assert.equal((await api('POST', `/api/public/orders/${s.secondOrderToken}/razorpay`)).status, 409);
  });

  it('updates dashboard payment split after an online payment', async () => {
    const d = await api('GET', '/api/admin/dashboard/overview', { token: s.token });
    assert.equal(d.body.data.today_revenue, 1419 + 499.5);
    const online = d.body.data.payment_methods.find((m) => m.method === 'razorpay');
    assert.equal(online.amount, 499.5);
  });
});

describe('UPI app payments (claim + staff confirmation)', () => {
  const regular = () => s.pizzaItem.option_groups[0].options[0].id; // Size: Regular (499.50 pizza)
  const placeOrder = async (pay_pref = 'upi') =>
    (await api('POST', `/api/public/t/${s.qrToken}/orders`, { body: { ...(pay_pref ? { pay_pref } : {}), items: [{ item_id: s.pizzaItem.id, quantity: 1, option_ids: [regular()] }] } })).body.data;

  it('refuses a claim while the restaurant has not enabled UPI', async () => {
    const order = await placeOrder('counter');
    assert.equal(order.payment_options.upi, false);
    assert.equal(order.upi, null);
    const r = await api('POST', `/api/public/orders/${order.token}/upi-claim`, { body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'UPI_NOT_AVAILABLE');
    s.upiOrder = order;
  });

  it('only accepts a payment choice the restaurant offers, and defaults to one it does', async () => {
    const path = `/api/public/t/${s.qrToken}/orders`;
    const items = [{ item_id: s.pizzaItem.id, quantity: 1, option_ids: [regular()] }];
    const upiWhileOff = await api('POST', path, { body: { pay_pref: 'upi', items } });
    assert.equal(upiWhileOff.status, 409);
    assert.equal(upiWhileOff.body.error.code, 'PAYMENT_METHOD_UNAVAILABLE');
    // Not choosing falls back to the first offered method (counter, while cash is on).
    const noChoice = await api('POST', path, { body: { items } });
    assert.equal(noChoice.status, 201);
    const mine = (await api('GET', '/api/admin/orders?status=pending', { token: s.token })).body.data.find((o) => o.id && o.pay_pref === 'counter');
    assert.ok(mine, 'defaulted to counter');
  });

  it('validates the UPI ID in payment settings', async () => {
    const bad = await api('PUT', '/api/admin/payment-settings', { token: s.token, body: { upi_id: 'not a upi id' } });
    assert.equal(bad.status, 400);
    const noId = await api('PUT', '/api/admin/payment-settings', { token: s.token, body: { upi_enabled: true } });
    assert.equal(noId.status, 400);
    const ok = await api('PUT', '/api/admin/payment-settings', { token: s.token, body: { upi_enabled: true, upi_id: 'tableseva.demo@okbank' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.upi_enabled, true);
    assert.equal(ok.body.data.upi_id, 'tableseva.demo@okbank');
    const menu = await api('GET', `/api/public/t/${s.qrToken}`);
    assert.equal(menu.body.data.payment_options.upi, true);
  });

  it('builds the UPI link on the server with the exact order amount', async () => {
    const r = await api('GET', `/api/public/orders/${s.upiOrder.token}`);
    const upi = r.body.data.upi;
    assert.equal(r.body.data.payment_options.upi, true);
    assert.equal(upi.vpa, 'tableseva.demo@okbank');
    assert.equal(upi.amount, 499.5);
    const q = new URLSearchParams(upi.query);
    assert.equal(q.get('pa'), 'tableseva.demo@okbank');
    assert.equal(q.get('am'), '499.50');
    assert.equal(q.get('cu'), 'INR');
    assert.equal(q.get('tr'), null, 'merchant-only parameters are not sent: PhonePe/GPay reject them for ordinary UPI IDs');
    assert.equal(q.get('mc'), null);
    assert.ok(q.get('tn').includes('T-01'));
    assert.ok(!upi.query.includes(' '), 'no raw spaces in the link');
  });

  it('with cash switched off, UPI is the only choice and counter is refused', async () => {
    const off = await api('PUT', '/api/admin/payment-settings', { token: s.token, body: { cash_enabled: false } });
    assert.equal(off.status, 200);
    const menu = await api('GET', `/api/public/t/${s.qrToken}`);
    assert.deepEqual(menu.body.data.payment_options, { cash: false, upi: true, razorpay: true, cashfree: false });
    const items = [{ item_id: s.pizzaItem.id, quantity: 1, option_ids: [regular()] }];
    const path = `/api/public/t/${s.qrToken}/orders`;
    const counter = await api('POST', path, { body: { pay_pref: 'counter', items } });
    assert.equal(counter.status, 409);
    assert.equal(counter.body.error.code, 'PAYMENT_METHOD_UNAVAILABLE');
    const upi = await api('POST', path, { body: { pay_pref: 'upi', items } });
    assert.equal(upi.status, 201);
    assert.equal(upi.body.data.payment_options.cash, false);
    assert.ok(upi.body.data.upi, 'the UPI link is there');
    // Leave cash on for the rest of the suite.
    assert.equal((await api('PUT', '/api/admin/payment-settings', { token: s.token, body: { cash_enabled: true } })).status, 200);
  });

  it('records a claim without marking the order paid', async () => {
    assert.equal((await api('POST', `/api/public/orders/${s.upiOrder.token}/upi-claim`, { body: { reference: 'bad ref!' } })).status, 400);
    const r = await api('POST', `/api/public/orders/${s.upiOrder.token}/upi-claim`, { body: { reference: '412345678901' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.payment_status, 'unpaid', 'a claim alone never counts as payment');
    assert.equal(r.body.data.payment_claim.reference, '412345678901');
    const admin = await api('GET', '/api/admin/orders?status=pending', { token: s.token });
    const mine = admin.body.data.find((o) => o.payment_claim?.reference === '412345678901');
    assert.ok(mine, 'admin can see the claim');
    s.upiOrderId = mine.id;
    const revenue = (await api('GET', '/api/admin/dashboard/overview', { token: s.token })).body.data.today_revenue;
    assert.equal(revenue, 1419 + 499.5, 'claimed-but-unconfirmed money is not revenue');
  });

  it('lets staff confirm the UPI payment, once', async () => {
    const paid = await api('POST', `/api/admin/orders/${s.upiOrderId}/upi-payment`, { token: s.token, body: {} });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.data.payment_status, 'paid');
    assert.equal(paid.body.data.payment_method, 'upi');
    assert.equal((await api('POST', `/api/admin/orders/${s.upiOrderId}/upi-payment`, { token: s.token, body: {} })).status, 409);
    assert.equal((await api('GET', `/api/public/orders/${s.upiOrder.token}`)).body.data.upi, null, 'no pay link once paid');
    const receipt = await api('GET', `/api/admin/orders/${s.upiOrderId}/receipt.pdf`, { token: s.token });
    assert.equal(receipt.status, 200);

    const d = (await api('GET', '/api/admin/dashboard/overview', { token: s.token })).body.data;
    assert.equal(d.today_revenue, 1419 + 499.5 + 499.5);
    assert.equal(d.payment_methods.find((m) => m.method === 'upi').amount, 499.5);
  });

  it('does not let one UPI reference confirm two orders', async () => {
    const second = await placeOrder();
    await api('POST', `/api/public/orders/${second.token}/upi-claim`, { body: { reference: '412345678901' } });
    const list = await api('GET', '/api/admin/orders?status=pending', { token: s.token });
    const id = list.body.data.find((o) => o.payment_claim)?.id;
    const dup = await api('POST', `/api/admin/orders/${id}/upi-payment`, { token: s.token, body: {} });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'DUPLICATE_REFERENCE');
  });
});

describe('only UPI (the default PAYMENT_METHODS)', () => {
  const ALL = new Set(['upi', 'cash', 'razorpay', 'cashfree']);
  const items = () => [{ item_id: s.pizzaItem.id, quantity: 1, option_ids: [s.pizzaItem.option_groups[0].options[0].id] }];
  const ordersPath = () => `/api/public/t/${s.qrToken}/orders`;
  let vendorId;

  before(async () => {
    vendorId = (await api('GET', '/api/auth/me', { token: s.token })).body.data.id;
    config.paymentMethods = new Set(['upi']);
  });
  after(() => {
    config.paymentMethods = ALL;
  });

  it('defaults to UPI only and rejects unknown method names', async () => {
    const run = (value) =>
      import(`../src/config.js?methods=${encodeURIComponent(value ?? 'unset')}`).then(
        (m) => [...m.config.paymentMethods],
        (err) => err.message,
      );
    const saved = process.env.PAYMENT_METHODS;
    try {
      delete process.env.PAYMENT_METHODS;
      assert.deepEqual(await run(undefined), ['upi']);
      process.env.PAYMENT_METHODS = 'upi, cash';
      assert.deepEqual(await run('upi, cash'), ['upi', 'cash']);
      process.env.PAYMENT_METHODS = 'upi,bitcoin';
      assert.match(await run('upi,bitcoin'), /PAYMENT_METHODS must list some of/);
    } finally {
      process.env.PAYMENT_METHODS = saved;
    }
  });

  it('offers only UPI to diners even though the restaurant also switched cash and Razorpay on', async () => {
    const menu = await api('GET', `/api/public/t/${s.qrToken}`);
    assert.deepEqual(menu.body.data.payment_options, { cash: false, upi: true, razorpay: false, cashfree: false });
    const me = await api('GET', '/api/auth/me', { token: s.token });
    assert.deepEqual(me.body.data.payment_methods, ['upi']);
    const settings = await api('GET', '/api/admin/payment-settings', { token: s.token });
    assert.deepEqual(settings.body.data.methods_available, ['upi']);
  });

  it('refuses the other ways of paying and defaults to UPI', async () => {
    for (const pay_pref of ['counter', 'online']) {
      const r = await api('POST', ordersPath(), { body: { pay_pref, items: items() } });
      assert.equal(r.status, 409, pay_pref);
      assert.equal(r.body.error.code, 'PAYMENT_METHOD_UNAVAILABLE');
    }
    const ok = await api('POST', ordersPath(), { body: { items: items() } });
    assert.equal(ok.status, 201);
    assert.ok(ok.body.data.upi, 'the UPI link is there');
    assert.deepEqual(ok.body.data.payment_options, { cash: false, upi: true, razorpay: false, cashfree: false });
    s.upiOnlyOrder = ok.body.data;

    const razorpay = await api('POST', `/api/public/orders/${ok.body.data.token}/razorpay`);
    assert.equal(razorpay.status, 409);
    assert.equal(razorpay.body.error.code, 'RAZORPAY_NOT_CONFIGURED');
  });

  it('does not let staff record cash, but still lets them confirm UPI', async () => {
    const id = (await api('GET', '/api/admin/orders?status=pending', { token: s.token })).body.data.find((o) => o.pay_pref === 'upi' && o.payment_status === 'unpaid')?.id;
    assert.ok(id);
    const cash = await api('POST', `/api/admin/orders/${id}/cash-payment`, { token: s.token });
    assert.equal(cash.status, 409);
    assert.equal(cash.body.error.code, 'METHOD_NOT_AVAILABLE');
    assert.equal((await api('POST', `/api/admin/orders/${id}/upi-payment`, { token: s.token, body: {} })).status, 200);
  });

  it('does not let a restaurant switch on a method the product does not offer, or switch off the last one', async () => {
    for (const body of [{ cash_enabled: true }, { razorpay_enabled: true }, { cashfree_enabled: true }]) {
      const r = await api('PUT', '/api/admin/payment-settings', { token: s.token, body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const off = await api('PUT', '/api/admin/payment-settings', { token: s.token, body: { upi_enabled: false } });
    assert.equal(off.status, 400);
    assert.match(off.body.error.message, /Turn on UPI/);
    assert.equal((await api('GET', '/api/admin/payment-settings', { token: s.token })).body.data.upi_enabled, true, 'unchanged');
  });

  it("stops a restaurant that has not set up UPI from taking orders, with a clear message", async () => {
    await db.query(`UPDATE vendor_payment_settings SET upi_enabled = false WHERE vendor_id = $1`, [vendorId]);
    try {
      const menu = await api('GET', `/api/public/t/${s.qrToken}`);
      assert.deepEqual(menu.body.data.payment_options, { cash: false, upi: false, razorpay: false, cashfree: false });
      const r = await api('POST', ordersPath(), { body: { items: items() } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'PAYMENTS_NOT_SET_UP');
    } finally {
      await db.query(`UPDATE vendor_payment_settings SET upi_enabled = true WHERE vendor_id = $1`, [vendorId]);
    }
    assert.equal((await api('POST', ordersPath(), { body: { items: items() } })).status, 201, 'works again once UPI is back on');
  });
});

describe('platform owner (super admin)', () => {
  const OWNER = 'platform.owner@mezmitra.test';
  let ownerToken;
  let ownerId;
  let spiceId;
  const baseItems = () => [{ item_id: s.pizzaItem.id, quantity: 1, option_ids: [s.pizzaItem.option_groups[0].options[0].id] }];

  before(async () => {
    const su = await api('POST', '/api/auth/signup', { body: { name: 'MezMitra HQ', email: OWNER, password: 'a-long-enough-password' } });
    ownerToken = su.body.data.token;
    ownerId = su.body.data.vendor.id;
    config.superAdminEmails = new Set([OWNER]);
    spiceId = (await api('GET', '/api/auth/me', { token: s.token })).body.data.id;
  });
  after(() => {
    config.superAdminEmails = new Set();
  });

  it('only shows the platform tools to the owner account', async () => {
    assert.equal((await api('GET', '/api/auth/me', { token: ownerToken })).body.data.is_super_admin, true);
    assert.equal((await api('GET', '/api/auth/me', { token: s.token })).body.data.is_super_admin, false);
    for (const path of ['/api/platform/overview', '/api/platform/restaurants']) {
      const r = await api('GET', path, { token: s.token });
      assert.equal(r.status, 403, path);
      assert.equal(r.body.error.code, 'FORBIDDEN');
      assert.equal((await api('GET', path)).status, 401, `${path} needs a sign-in`);
    }
    const patch = await api('PATCH', `/api/platform/restaurants/${spiceId}`, { token: s.token, body: { suspended: true } });
    assert.equal(patch.status, 403, 'a restaurant cannot suspend anyone, itself included');
  });

  it('lists every restaurant with its numbers, and can search and filter', async () => {
    const overview = (await api('GET', '/api/platform/overview', { token: ownerToken })).body.data;
    assert.ok(overview.restaurants.total >= 2);
    assert.equal(overview.restaurants.active, overview.restaurants.total);
    assert.equal(overview.restaurants.suspended, 0);
    assert.ok(overview.orders_30d > 0 && overview.revenue_30d > 0);

    const list = await api('GET', '/api/platform/restaurants', { token: ownerToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.meta.total, overview.restaurants.total);
    const spice = list.body.data.find((r) => r.id === spiceId);
    assert.equal(spice.name, 'Spice Hub');
    assert.equal(spice.status, 'active');
    assert.ok(spice.tables >= 1 && spice.items >= 1 && spice.orders_total >= 1 && spice.orders_30d >= 1);
    assert.ok(spice.revenue_total > 0 && spice.last_order_at);
    assert.equal(spice.upi_ready, true);
    assert.equal(spice.password_hash, undefined);
    const hq = list.body.data.find((r) => r.id === ownerId);
    assert.equal(hq.is_platform_owner, true);
    assert.equal(hq.orders_total, 0);
    assert.equal(hq.upi_ready, false);

    const byName = await api('GET', '/api/platform/restaurants?q=spice', { token: ownerToken });
    assert.deepEqual(byName.body.data.map((r) => r.id), [spiceId]);
    const byEmail = await api('GET', `/api/platform/restaurants?q=${encodeURIComponent('platform.owner')}`, { token: ownerToken });
    assert.deepEqual(byEmail.body.data.map((r) => r.id), [ownerId]);
    assert.equal((await api('GET', '/api/platform/restaurants?status=suspended', { token: ownerToken })).body.meta.total, 0);
    const paged = await api('GET', '/api/platform/restaurants?per_page=1&page=2', { token: ownerToken });
    assert.equal(paged.body.data.length, 1);
    assert.equal((await api('GET', '/api/platform/restaurants?per_page=1000', { token: ownerToken })).status, 400);
  });

  it('suspends a restaurant: no sign-in, no admin API, no orders; reactivating undoes all of it', async () => {
    const off = await api('PATCH', `/api/platform/restaurants/${spiceId}`, { token: ownerToken, body: { suspended: true, reason: 'unpaid invoice' } });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.status, 'suspended');
    assert.equal(off.body.data.suspended_reason, 'unpaid invoice');
    assert.ok(off.body.data.suspended_at);

    // Its own people are turned away, even with a token that was issued before.
    const login = await api('POST', '/api/auth/login', { body: { email: 'owner@spice.test', password: 'a-long-enough-password' } });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'ACCOUNT_SUSPENDED');
    assert.match(login.body.error.message, /unpaid invoice/);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'owner@spice.test', password: 'wrong-password-1' } })).status, 401, 'a wrong password still says so');
    for (const path of ['/api/auth/me', '/api/admin/orders', '/api/admin/categories']) {
      const r = await api('GET', path, { token: s.token });
      assert.equal(r.status, 403, path);
      assert.equal(r.body.error.code, 'ACCOUNT_SUSPENDED');
    }

    // Its tables stop taking orders.
    const menu = await api('GET', `/api/public/t/${s.qrToken}`);
    assert.equal(menu.status, 409);
    assert.equal(menu.body.error.code, 'TABLE_UNAVAILABLE');
    const order = await api('POST', `/api/public/t/${s.qrToken}/orders`, { body: { items: baseItems() } });
    assert.equal(order.status, 409);

    const suspendedList = await api('GET', '/api/platform/restaurants?status=suspended', { token: ownerToken });
    assert.deepEqual(suspendedList.body.data.map((r) => r.id), [spiceId]);
    assert.equal((await api('GET', '/api/platform/overview', { token: ownerToken })).body.data.restaurants.suspended, 1);

    const on = await api('PATCH', `/api/platform/restaurants/${spiceId}`, { token: ownerToken, body: { suspended: false } });
    assert.equal(on.body.data.status, 'active');
    assert.equal(on.body.data.suspended_reason, null);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'owner@spice.test', password: 'a-long-enough-password' } })).status, 200);
    assert.equal((await api('GET', '/api/auth/me', { token: s.token })).status, 200, 'the old token works again');
    assert.equal((await api('GET', `/api/public/t/${s.qrToken}`)).status, 200);
  });

  it('never suspends a platform owner, and validates its input', async () => {
    const self = await api('PATCH', `/api/platform/restaurants/${ownerId}`, { token: ownerToken, body: { suspended: true } });
    assert.equal(self.status, 409);
    assert.equal(self.body.error.code, 'CANNOT_SUSPEND');
    assert.equal((await api('GET', '/api/auth/me', { token: ownerToken })).status, 200);

    assert.equal((await api('PATCH', `/api/platform/restaurants/${spiceId}`, { token: ownerToken, body: {} })).status, 400);
    assert.equal((await api('PATCH', `/api/platform/restaurants/${spiceId}`, { token: ownerToken, body: { suspended: 'yes' } })).status, 400);
    assert.equal((await api('PATCH', `/api/platform/restaurants/${spiceId}`, { token: ownerToken, body: { suspended: true, reason: 'x'.repeat(201) } })).status, 400);
    assert.equal((await api('PATCH', '/api/platform/restaurants/999999', { token: ownerToken, body: { suspended: true } })).status, 404);
    assert.equal((await api('PATCH', '/api/platform/restaurants/abc', { token: ownerToken, body: { suspended: true } })).status, 404);
  });

  it('gives nobody platform access when SUPER_ADMIN_EMAILS is empty', async () => {
    config.superAdminEmails = new Set();
    try {
      assert.equal((await api('GET', '/api/platform/overview', { token: ownerToken })).status, 403);
      assert.equal((await api('GET', '/api/auth/me', { token: ownerToken })).body.data.is_super_admin, false);
    } finally {
      config.superAdminEmails = new Set([OWNER]);
    }
  });
});

describe('password reset by email', () => {
  const EMAIL = 'forgetful@example.test';
  const OLD = 'the-old-password-1';
  const NEW = 'a-brand-new-password-2';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tokenFrom = (mail) => new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
  let oldSession;
  let vendorId;

  before(async () => {
    const su = await api('POST', '/api/auth/signup', { body: { name: 'Forgetful Cafe', email: EMAIL, password: OLD } });
    oldSession = su.body.data.token;
    vendorId = su.body.data.vendor.id;
  });

  it('answers the same for unknown and known emails, and only mails real accounts', async () => {
    const before = sentMail.length;
    const unknown = await api('POST', '/api/auth/forgot-password', { body: { email: 'nobody@example.test' } });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body, { data: { ok: true } });
    assert.equal(sentMail.length, before, 'no email for an unknown address');

    const known = await api('POST', '/api/auth/forgot-password', { body: { email: EMAIL.toUpperCase() } });
    assert.equal(known.status, 200);
    assert.deepEqual(known.body, unknown.body, 'identical answer: the form cannot be used to find accounts');
    assert.equal(sentMail.length, before + 1);
    const mail = sentMail.at(-1);
    assert.equal(mail.to, EMAIL);
    assert.match(mail.subject, /Reset your MezMitra password/);
    assert.ok(mail.text.includes(`${config.adminAppUrl}/reset-password?token=`));
    assert.ok(mail.html.includes('/reset-password?token='));
    assert.equal((await api('POST', '/api/auth/forgot-password', { body: { email: 'not an email' } })).status, 400);

    const again = await api('POST', '/api/auth/forgot-password', { body: { email: EMAIL } });
    assert.equal(again.status, 200);
    assert.equal(sentMail.length, before + 1, 'at most one email a minute per account');
  });

  it('stores only a hash of the token', async () => {
    const token = tokenFrom(sentMail.at(-1));
    const { rows } = await db.query(`SELECT token_hash FROM password_resets WHERE vendor_id = $1`, [vendorId]);
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].token_hash.includes(token));
    assert.match(rows[0].token_hash, /^[a-f0-9]{64}$/);
  });

  it('rejects bad tokens and weak passwords without using the token up', async () => {
    const token = tokenFrom(sentMail.at(-1));
    const wrong = await api('POST', '/api/auth/reset-password', { body: { token: 'x'.repeat(43), password: NEW } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'INVALID_RESET_TOKEN');
    assert.equal((await api('POST', '/api/auth/reset-password', { body: { token: 'short', password: NEW } })).status, 400);
    assert.equal((await api('POST', '/api/auth/reset-password', { body: { token, password: 'short' } })).status, 400);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: EMAIL, password: OLD } })).status, 200, 'the old password still works');
  });

  it('refuses an expired link', async () => {
    const token = tokenFrom(sentMail.at(-1));
    await db.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE vendor_id = $1`, [vendorId]);
    const r = await api('POST', '/api/auth/reset-password', { body: { token, password: NEW } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_RESET_TOKEN');
    // A fresh request (after the one-minute pause) gets a working link again.
    await db.query(`UPDATE password_resets SET created_at = now() - interval '2 minutes' WHERE vendor_id = $1`, [vendorId]);
    assert.equal((await api('POST', '/api/auth/forgot-password', { body: { email: EMAIL } })).status, 200);
  });

  it('sets the new password once, signs out old sessions, and the link cannot be reused', async () => {
    const token = tokenFrom(sentMail.at(-1));
    await wait(1100); // token times are whole seconds: make sure the old session is clearly older than the change
    const ok = await api('POST', '/api/auth/reset-password', { body: { token, password: NEW } });
    assert.equal(ok.status, 200);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: EMAIL, password: OLD } })).status, 401);
    const login = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: NEW } });
    assert.equal(login.status, 200);
    assert.equal((await api('GET', '/api/auth/me', { token: login.body.data.token })).status, 200, 'a session started after the change works');

    const stale = await api('GET', '/api/auth/me', { token: oldSession });
    assert.equal(stale.status, 401, 'a session from before the change is signed out');
    assert.match(stale.body.error.message, /password was changed/);

    const reuse = await api('POST', '/api/auth/reset-password', { body: { token, password: 'yet-another-password-3' } });
    assert.equal(reuse.status, 400);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: EMAIL, password: NEW } })).status, 200, 'unchanged by the failed reuse');
  });

  it('only the newest link works, and suspended accounts get no email', async () => {
    await db.query(`UPDATE password_resets SET created_at = now() - interval '2 minutes' WHERE vendor_id = $1`, [vendorId]);
    await api('POST', '/api/auth/forgot-password', { body: { email: EMAIL } });
    const first = tokenFrom(sentMail.at(-1));
    await db.query(`UPDATE password_resets SET created_at = now() - interval '2 minutes' WHERE vendor_id = $1`, [vendorId]);
    await api('POST', '/api/auth/forgot-password', { body: { email: EMAIL } });
    const second = tokenFrom(sentMail.at(-1));
    assert.notEqual(first, second);
    assert.equal((await api('POST', '/api/auth/reset-password', { body: { token: first, password: NEW + 'x' } })).status, 400, 'older link is void');
    assert.equal((await api('POST', '/api/auth/reset-password', { body: { token: second, password: NEW + 'x' } })).status, 200);

    await db.query(`UPDATE vendors SET suspended_at = now() WHERE id = $1`, [vendorId]);
    const count = sentMail.length;
    assert.equal((await api('POST', '/api/auth/forgot-password', { body: { email: EMAIL } })).status, 200);
    assert.equal(sentMail.length, count);
    await db.query(`UPDATE vendors SET suspended_at = NULL WHERE id = $1`, [vendorId]);
  });
});

describe('sold-out dishes', () => {
  const orderBody = () => ({ items: [{ item_id: s.pizzaItem.id, quantity: 1, option_ids: [s.pizzaItem.option_groups[0].options[0].id] }] });
  const stock = async () => (await api('GET', '/api/admin/items?per_page=100', { token: s.token })).body;

  it('flips a dish to sold out and back with one request', async () => {
    assert.equal((await stock()).meta.sold_out, 0);
    const bad = await api('PATCH', `/api/admin/items/${s.pizzaItem.id}`, { token: s.token, body: { is_sold_out: 'yes' } });
    assert.equal(bad.status, 400);
    const off = await api('PATCH', `/api/admin/items/${s.pizzaItem.id}`, { token: s.token, body: { is_sold_out: true } });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.is_sold_out, true);
    assert.equal(off.body.data.is_active, true, 'still on the menu');
    const list = await stock();
    assert.equal(list.meta.sold_out, 1);
    assert.equal((await api('GET', '/api/admin/items?status=sold_out', { token: s.token })).body.data.map((i) => i.id).join(), String(s.pizzaItem.id));
    const on = await api('PATCH', `/api/admin/items/${s.pizzaItem.id}`, { token: s.token, body: { is_sold_out: false } });
    assert.equal(on.body.data.is_sold_out, false);
    assert.equal((await stock()).meta.sold_out, 0);
  });

  it('keeps a sold-out dish visible to diners but refuses to order it', async () => {
    await api('PATCH', `/api/admin/items/${s.pizzaItem.id}`, { token: s.token, body: { is_sold_out: true } });
    const menu = await api('GET', `/api/public/t/${s.qrToken}`);
    const dish = menu.body.data.items.find((i) => i.id === s.pizzaItem.id);
    assert.ok(dish, 'still listed');
    assert.equal(dish.is_sold_out, true);
    assert.ok(menu.body.data.items.filter((i) => i.id !== s.pizzaItem.id).every((i) => i.is_sold_out === false), 'other dishes are unaffected');

    const order = await api('POST', `/api/public/t/${s.qrToken}/orders`, { body: orderBody() });
    assert.equal(order.status, 409);
    assert.equal(order.body.error.code, 'ITEM_UNAVAILABLE');
  });

  it('puts every sold-out dish back in stock at once, and only for this restaurant', async () => {
    const other = await api('POST', '/api/auth/signup', { body: { name: 'Other Place', email: 'other.place@example.test', password: 'a-long-enough-password' } });
    assert.equal((await api('POST', '/api/admin/items/restock', { token: other.body.data.token })).body.data.restocked, 0);
    assert.equal((await stock()).meta.sold_out, 1, "another restaurant's restock changes nothing here");

    const r = await api('POST', '/api/admin/items/restock', { token: s.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.restocked, 1);
    assert.equal((await stock()).meta.sold_out, 0);
    assert.equal((await api('POST', `/api/public/t/${s.qrToken}/orders`, { body: orderBody() })).status, 201, 'orderable again');
    assert.equal((await api('POST', '/api/admin/items/restock')).status, 401);
  });
});

describe('sales reports (summary, CSV, PDF)', () => {
  const ymd = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const get = (path, token = s.token) => api('GET', `/api/admin/reports/${path}`, { token });

  it('writes spreadsheet cells safely', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell(12.5), '12.5');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
    for (const evil of ['=1+1', '+1', '-1', '@SUM(A1)']) assert.equal(csvCell(evil), `'${evil}`, evil);
    assert.equal(csvCell('=HYPERLINK("http://x")'), '"\'=HYPERLINK(""http://x"")"');
    assert.ok(toCsv([['a', 'b'], [1, 2]]).startsWith('﻿a,b\r\n1,2\r\n'));
  });

  it("today's summary agrees with the dashboard and splits money by payment method", async () => {
    const r = await get('summary');
    assert.equal(r.status, 200);
    const d = r.body.data;
    const dashboard = (await api('GET', '/api/admin/dashboard/overview', { token: s.token })).body.data;
    assert.equal(d.from, d.to);
    assert.equal(d.sales.total, dashboard.today_revenue, 'same definition of revenue as the dashboard');
    assert.ok(d.sales.orders >= 1);
    assert.equal(Math.round(d.sales.by_method.reduce((n, m) => n + m.amount, 0) * 100) / 100, d.sales.total);
    assert.deepEqual(d.sales.by_method.map((m) => m.method), ['upi', 'cash', 'razorpay', 'cashfree']);
    assert.equal(Math.round((d.sales.subtotal + d.sales.tax) * 100) / 100, d.sales.total);
    assert.equal(d.placed.total, d.placed.completed + d.placed.cancelled + d.placed.open);
    assert.ok(d.placed.unpaid >= 1 && d.placed.unpaid_value > 0);
    assert.ok(d.top_items.length >= 1 && d.top_items[0].quantity >= 1);
  });

  it('counts only the days asked for, and only this restaurant', async () => {
    const past = (await get(`summary?from=${ymd(-40)}&to=${ymd(-30)}`)).body.data;
    assert.deepEqual([past.sales.orders, past.sales.total, past.placed.total, past.top_items.length], [0, 0, 0, 0]);
    const wide = (await get(`summary?from=${ymd(-30)}&to=${ymd(1)}`)).body.data;
    const today = (await get('summary')).body.data;
    assert.equal(wide.sales.total, today.sales.total);
    const other = await api('POST', '/api/auth/signup', { body: { name: 'Quiet Place', email: 'quiet.place@example.test', password: 'a-long-enough-password' } });
    const mine = await get('summary', other.body.data.token);
    assert.deepEqual([mine.body.data.sales.orders, mine.body.data.placed.total], [0, 0]);
  });

  it('validates the dates', async () => {
    for (const q of ['from=2026-13-01', 'from=yesterday', 'from=2026-02-30', `from=${ymd(0)}&to=${ymd(-1)}`, `from=${ymd(-200)}&to=${ymd(0)}`]) {
      const r = await get(`summary?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal((await get(`summary?from=${ymd(0)}`)).status, 200, 'a single date means that one day');
    assert.equal((await api('GET', '/api/admin/reports/summary')).status, 401);
    assert.equal((await api('GET', '/api/admin/reports/orders.csv')).status, 401);
  });

  it('downloads a CSV with one row per order', async () => {
    const summary = (await get('summary')).body.data;
    const r = await get('orders.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="orders-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = r.body.toString('utf8');
    assert.ok(text.startsWith('﻿Order no,Placed at,Paid at,Table,Status,Payment status,Payment method,Dishes,Subtotal,Tax,Total\r\n'));
    const lines = text.slice(1).trim().split('\r\n');
    assert.ok(lines.length - 1 >= summary.placed.total, 'a row for every order placed (and paid) today');
    const paidRow = lines.find((l) => l.includes(',paid,'));
    assert.match(paidRow, /^\d+,\d{4}-\d{2}-\d{2} \d{2}:\d{2},\d{4}-\d{2}-\d{2} \d{2}:\d{2},T-01,\w+,paid,(cash|upi|razorpay),/);
    assert.match(paidRow, /,\d+\.\d{2},\d+\.\d{2},\d+\.\d{2}$/);
    const empty = await get(`orders.csv?from=${ymd(-40)}&to=${ymd(-30)}`);
    assert.equal(empty.body.toString('utf8').trim().split('\r\n').length, 1, 'header only');
    assert.match(empty.headers.get('content-disposition'), /orders-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv/);
  });

  it('downloads a PDF report', async () => {
    const r = await get('report.pdf');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.match(r.headers.get('content-disposition'), /attachment; filename="sales-report-/);
    assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
    assert.ok(r.body.length > 1500);
    const empty = await get(`report.pdf?from=${ymd(-40)}&to=${ymd(-30)}`);
    assert.equal(empty.body.subarray(0, 5).toString(), '%PDF-');
  });
});

describe('demo data helpers (sample prices and order history)', () => {
  const OWNER = 'demo.helper@example.test';
  let token;
  let vendorId;
  let qr;
  let chaiId;

  const orderRows = async () => (await db.query(`SELECT * FROM orders WHERE vendor_id = $1 ORDER BY id`, [vendorId])).rows;
  const sampleRows = async () => (await db.query(`SELECT * FROM orders WHERE vendor_id = $1 AND idempotency_key LIKE 'demo-history-%'`, [vendorId])).rows;

  before(async () => {
    const su = await api('POST', '/api/auth/signup', { body: { name: 'Demo Helper Cafe', email: OWNER, password: 'a-long-enough-password' } });
    token = su.body.data.token;
    vendorId = su.body.data.vendor.id;
    await api('PATCH', '/api/admin/vendor', { token, body: { tax_percent: 5 } });
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Chai' } })).body.data;
    const chai = await api('POST', '/api/admin/items', {
      token,
      body: { category_id: cat.id, name: 'Masala Chai', price: 35, option_groups: [{ name: 'Size', required: true, multi_select: false, options: [{ name: 'Regular', price: 0 }, { name: 'Large', price: 15 }] }] },
    });
    chaiId = chai.body.data.id;
    await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Samosa', price: 20 } });
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'A1', capacity: 2 } })).body.data.qr_url.split('/').pop();
    await api('PUT', '/api/admin/payment-settings', { token, body: { upi_enabled: true, upi_id: 'helper@okaxis' } });
  });

  it('makes every dish cost the same and the extras free, so an order is exactly that much', async () => {
    const { setAllPrices } = await import('../src/demoPrices.js');
    const r = await setAllPrices(db, { vendorId, rupees: 1 });
    assert.deepEqual(r, { items: 2, options: 1 });
    const menu = (await api('GET', `/api/public/t/${qr}`)).body.data;
    assert.deepEqual(menu.items.map((i) => i.price), [1, 1]);
    assert.ok(menu.items.every((i) => i.option_groups.every((g) => g.options.every((o) => o.price === 0))));
    const large = menu.items.find((i) => i.id === chaiId).option_groups[0].options[1];
    const order = await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: chaiId, quantity: 1, option_ids: [large.id] }] } });
    assert.equal(order.status, 201);
    assert.equal(order.body.data.subtotal, 1, 'a Large chai is still Rs 1');
    assert.equal(order.body.data.total, 1.05, 'Rs 1 plus 5% tax');
  });

  it('adds a few paid, completed orders that agree with the dashboard and reports, and only touches its own', async () => {
    const { generateHistory } = await import('../src/demoHistory.js');
    const realBefore = (await orderRows()).length;
    const r = await generateHistory(db, { vendorId, days: 2, orders: 4 });
    assert.equal(r.orders, 4);
    assert.equal(r.paid, 4);
    assert.equal(r.cancelled, 0);

    const rows = await sampleRows();
    assert.equal(rows.length, 4);
    assert.ok(rows.every((o) => o.status === 'completed' && o.payment_status === 'paid' && o.payment_method === 'upi' && o.pay_pref === 'upi'));
    assert.ok(rows.every((o) => o.accepted_at && o.paid_at && o.completed_at && new Date(o.created_at) < new Date(o.accepted_at) && new Date(o.accepted_at) < new Date(o.paid_at) && new Date(o.paid_at) < new Date(o.completed_at)));
    assert.ok(rows.every((o) => new Date(o.completed_at) < new Date()), 'nothing is "in the future"');
    assert.equal((await orderRows()).length, realBefore + 4, 'real orders untouched');

    const items = (await db.query(`SELECT count(*)::int AS n, sum(line_total_paise)::int AS paise FROM order_items WHERE order_id = ANY($1::bigint[])`, [rows.map((o) => o.id)])).rows[0];
    assert.ok(items.n >= 4);
    assert.equal(items.paise, rows.reduce((n, o) => n + o.subtotal_paise, 0), 'line items add up to each order subtotal');
    assert.ok(rows.every((o) => o.total_paise === o.subtotal_paise + o.tax_paise));
    const payments = (await db.query(`SELECT count(*)::int AS n, sum(amount_paise)::int AS paise FROM payments WHERE order_id = ANY($1::bigint[]) AND provider = 'upi' AND status = 'paid'`, [rows.map((o) => o.id)])).rows[0];
    assert.deepEqual([payments.n, payments.paise], [4, rows.reduce((n, o) => n + o.total_paise, 0)]);

    const dash = (await api('GET', '/api/admin/dashboard/overview', { token })).body.data;
    const realPaid = (await orderRows()).filter((o) => o.payment_status === 'paid' && !o.idempotency_key?.startsWith('demo-history-')).reduce((n, o) => n + o.total_paise, 0);
    assert.equal(Math.round(dash.weekly_revenue.reduce((n, d) => n + d.revenue, 0) * 100), Math.round(r.revenue * 100) + realPaid, 'the 7-day chart counts the sample payments');
    assert.equal(dash.payment_methods.find((m) => m.method === 'upi').percent, 100);
    const summary = (await api('GET', `/api/admin/reports/summary?from=${new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}`, { token })).body.data;
    assert.equal(summary.sales.orders, 4);
  });

  it('regenerates instead of piling up, and removes only the sample orders', async () => {
    const { generateHistory, removeHistory } = await import('../src/demoHistory.js');
    await generateHistory(db, { vendorId, days: 2, orders: 3 });
    assert.equal((await sampleRows()).length, 3, 'a second run replaces the first');
    const busy = await generateHistory(db, { vendorId, days: 7 });
    assert.ok(busy.orders > 60 && busy.cancelled >= 0 && busy.revenue > 0, 'busy mode makes a big history');
    assert.equal((await sampleRows()).length, busy.orders);
    const real = (await orderRows()).length - busy.orders;
    assert.equal(real, 1, 'the one real order from earlier is still there');
    assert.equal(await removeHistory(db, { vendorId }), busy.orders);
    assert.equal((await orderRows()).length, 1);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM payments WHERE provider_payment_id LIKE '4%' AND order_id NOT IN (SELECT id FROM orders)`)).rows[0].n, 0);
  });

  it('refuses to invent orders for a restaurant without a menu or tables', async () => {
    const { generateHistory } = await import('../src/demoHistory.js');
    const empty = await api('POST', '/api/auth/signup', { body: { name: 'Empty Place', email: 'empty.place@example.test', password: 'a-long-enough-password' } });
    await assert.rejects(generateHistory(db, { vendorId: empty.body.data.vendor.id, days: 2, orders: 4 }), /needs a menu and at least one table/);
  });
});

describe('UPI needs a UPI ID', () => {
  let token;
  let qr;
  let itemId;
  const put = (body) => api('PUT', '/api/admin/payment-settings', { token, body });
  const order = async () => (await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: itemId, quantity: 1, option_ids: [] }] } })).body.data;

  before(async () => {
    const su = await api('POST', '/api/auth/signup', { body: { name: 'Mobile Pay Cafe', email: 'mobile.pay@example.test', password: 'a-long-enough-password' } });
    token = su.body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data.id;
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'M1', capacity: 2 } })).body.data.qr_url.split('/').pop();
  });

  it('refuses to switch UPI on without a UPI ID', async () => {
    const r = await put({ upi_enabled: true });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /UPI ID/);
  });

  it('has no mobile-number setting any more: it is not returned and a value sent for it is ignored', async () => {
    const r = await put({ upi_enabled: true, upi_id: 'mobile.pay@okaxis', upi_mobile: '9876543210' });
    assert.equal(r.status, 200);
    assert.equal('upi_mobile' in r.body.data, false);
    assert.equal('upi_mobile' in (await api('GET', '/api/admin/payment-settings', { token })).body.data, false);
    const o = await order();
    assert.equal('mobile' in o.upi, false, 'the diner is only ever shown the UPI ID');
    assert.equal(o.upi.vpa, 'mobile.pay@okaxis');
    assert.equal(new URLSearchParams(o.upi.query).get('pa'), 'mobile.pay@okaxis');
  });

  it('refuses to remove the UPI ID while UPI is on', async () => {
    assert.equal((await put({ upi_id: '' })).status, 400);
    assert.equal((await api('GET', '/api/admin/payment-settings', { token })).body.data.upi_id, 'mobile.pay@okaxis', 'a refused change keeps the ID');
  });
});

describe('UPI app buttons (off by default)', () => {
  let token;
  let qr;
  let itemId;
  const put = (body) => api('PUT', '/api/admin/payment-settings', { token, body });
  const order = async () => (await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: itemId, quantity: 1, option_ids: [] }] } })).body.data;

  before(async () => {
    const su = await api('POST', '/api/auth/signup', { body: { name: 'Buttons Cafe', email: 'buttons.cafe@example.test', password: 'a-long-enough-password' } });
    token = su.body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data.id;
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'B1', capacity: 2 } })).body.data.qr_url.split('/').pop();
  });

  it('keeps the Google Pay / PhonePe / Paytm buttons off until the restaurant turns them on', async () => {
    const on = await put({ upi_enabled: true, upi_id: 'buttons.cafe@okaxis' });
    assert.equal(on.status, 200);
    assert.equal(on.body.data.upi_pay_buttons, false, 'off by default');
    const off = await order();
    assert.equal(off.upi.pay_buttons, false);
    assert.ok(off.upi.query, 'the link still exists, for the QR code');
    assert.equal(off.upi.vpa, 'buttons.cafe@okaxis');

    const set = await put({ upi_pay_buttons: true });
    assert.equal(set.body.data.upi_pay_buttons, true);
    assert.equal((await order()).upi.pay_buttons, true);
    assert.equal((await put({ upi_pay_buttons: 'yes' })).status, 400);
    assert.equal((await put({ upi_pay_buttons: false })).body.data.upi_pay_buttons, false);
    assert.equal((await order()).upi.pay_buttons, false);
  });

  it('cannot turn the buttons on for a restaurant that has no UPI ID', async () => {
    assert.equal((await put({ upi_id: '' })).status, 400, 'UPI is on, so its ID cannot be removed');
    assert.equal((await put({ upi_pay_buttons: true })).status, 200);
    assert.equal((await order()).upi.vpa, 'buttons.cafe@okaxis');
  });
});

describe('online payments (Cashfree)', () => {
  const APP_ID = 'TESTAPP12345';
  const SECRET = 'cfsk_ma_test_secret_value';
  let token;
  let qr;
  let itemId;
  let mock;
  let savedBase;
  const cfOrders = new Map(); // Cashfree order id -> { amount, status }
  const cfCalls = [];
  const put = (body) => api('PUT', '/api/admin/payment-settings', { token, body });
  const place = async (pay_pref) => {
    const r = await api('POST', `/api/public/t/${qr}/orders`, { body: { pay_pref, items: [{ item_id: itemId, quantity: 2, option_ids: [] }] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };
  const start = (order) => api('POST', `/api/public/orders/${order.token}/cashfree`);
  const verify = (order) => api('POST', `/api/public/orders/${order.token}/cashfree/verify`);
  const status = async (order) => (await api('GET', `/api/public/orders/${order.token}`)).body.data;

  before(async () => {
    // A fake Cashfree API: it checks the keys, remembers the orders it was asked to create, and lets the test decide who "paid".
    mock = await new Promise((resolve) => {
      const server = http
        .createServer((req, res) => {
          let data = '';
          req.on('data', (c) => (data += c));
          req.on('end', () => {
            cfCalls.push({ method: req.method, url: req.url, headers: req.headers, body: data ? JSON.parse(data) : null });
            res.setHeader('Content-Type', 'application/json');
            const send = (code, json) => {
              res.statusCode = code;
              res.end(JSON.stringify(json));
            };
            if (req.headers['x-client-id'] !== APP_ID || req.headers['x-client-secret'] !== SECRET) {
              return send(401, { message: 'authentication Failed', code: 'request_failed', type: 'authentication_error' });
            }
            const path = req.url.split('?')[0];
            if (req.method === 'POST' && path === '/orders') {
              const body = JSON.parse(data);
              cfOrders.set(body.order_id, { amount: body.order_amount, status: 'ACTIVE' });
              return send(200, { order_id: body.order_id, order_status: 'ACTIVE', payment_session_id: `session_${body.order_id}` });
            }
            const m = path.match(/^\/orders\/([^/]+)(\/payments)?$/);
            const found = m && cfOrders.get(decodeURIComponent(m[1]));
            if (!found) return send(404, { message: 'order not found', code: 'order_not_found', type: 'invalid_request_error' });
            if (m[2]) return send(200, [{ cf_payment_id: 5551234, payment_status: 'SUCCESS' }]);
            return send(200, { order_id: decodeURIComponent(m[1]), order_amount: found.amount, order_status: found.status, payment_session_id: `session_${decodeURIComponent(m[1])}` });
          });
        })
        .listen(0, '127.0.0.1', () => resolve(server));
    });
    savedBase = config.cashfreeApiBase;
    config.cashfreeApiBase = `http://127.0.0.1:${mock.address().port}`;

    token = (await api('POST', '/api/auth/signup', { body: { name: 'Cashfree Cafe', email: 'cashfree.cafe@example.test', password: 'a-long-enough-password' } })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Masala Chai', price: 40 } })).body.data.id;
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'C1', capacity: 2 } })).body.data.qr_url.split('/').pop();
  });

  after(async () => {
    config.cashfreeApiBase = savedBase;
    await new Promise((r) => mock.close(r));
  });

  it('tells the diner to pay another way while the restaurant has no Cashfree keys', async () => {
    const order = await place(); // "online" is not offered yet, so the default (the counter) is used
    const r = await start(order);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CASHFREE_NOT_CONFIGURED');
  });

  it('validates and stores the keys without ever returning the secret', async () => {
    assert.equal((await put({ cashfree_app_id: 'no spaces allowed', cashfree_secret: SECRET })).status, 400);
    assert.equal((await put({ cashfree_enabled: true })).status, 400, 'no keys yet');

    const wrong = await put({ cashfree_enabled: true, cashfree_app_id: APP_ID, cashfree_secret: 'wrong-secret-value' });
    assert.equal(wrong.status, 200);
    const failing = await api('POST', '/api/admin/payment-settings/test', { token, body: { provider: 'cashfree' } });
    assert.equal(failing.status, 502);
    assert.equal(failing.body.error.code, 'CASHFREE_BAD_KEYS');

    const saved = await put({ cashfree_secret: SECRET });
    assert.equal(saved.body.data.cashfree_configured, true);
    assert.equal(saved.body.data.cashfree_mode, 'test', 'App IDs starting with TEST are Cashfree sandbox');
    assert.equal(saved.body.data.cashfree_app_id, APP_ID);
    assert.ok(!JSON.stringify(saved.body).includes(SECRET));
    const stored = await db.query(`SELECT cashfree_secret_enc FROM vendor_payment_settings WHERE cashfree_app_id = $1`, [APP_ID]);
    assert.ok(stored.rows.every((row) => !String(row.cashfree_secret_enc).includes(SECRET)), 'secret is encrypted at rest');
    const ok = await api('POST', '/api/admin/payment-settings/test', { token, body: { provider: 'cashfree' } });
    assert.equal(ok.body.data.ok, true);
    assert.equal(ok.body.data.mode, 'test');

    const menu = await api('GET', `/api/public/t/${qr}`);
    assert.equal(menu.body.data.payment_options.cashfree, true);
    assert.equal(menu.body.data.payment_options.razorpay, false);
  });

  it('lets a restaurant use one online gateway at a time', async () => {
    const both = await put({ razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' });
    assert.equal(both.status, 400);
    assert.match(both.body.error.message, /one online payment gateway/);
    const swap = await put({ cashfree_enabled: false, razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' });
    assert.equal(swap.status, 200, 'switching is one request');
    assert.equal((await api('GET', `/api/public/t/${qr}`)).body.data.payment_options.cashfree, false);
    const back = await put({ razorpay_enabled: false, cashfree_enabled: true });
    assert.equal(back.status, 200);
    assert.equal(back.body.data.cashfree_secret_set, true, 'the saved secret is kept');
  });

  it('creates one Cashfree order (reused on retry) and marks the order paid only when Cashfree says PAID', async () => {
    const order = await place('online');
    const posts = () => cfCalls.filter((c) => c.method === 'POST' && c.url === '/orders').length;
    const before = posts();

    const a = await start(order);
    assert.equal(a.status, 200);
    assert.equal(a.body.data.mode, 'sandbox');
    assert.equal(a.body.data.amount, 80);
    assert.match(a.body.data.payment_session_id, /^session_mz_/);
    const created = cfCalls.filter((c) => c.method === 'POST' && c.url === '/orders').at(-1);
    assert.equal(created.body.order_amount, 80);
    assert.equal(created.body.order_currency, 'INR');
    assert.ok(created.body.customer_details.customer_phone, 'Cashfree needs a phone number');
    assert.match(created.body.order_meta.return_url, new RegExp(`/o/${order.token}$`));

    const b = await start(order);
    assert.equal(b.body.data.payment_session_id, a.body.data.payment_session_id);
    assert.equal(posts() - before, 1, 'retrying must not create a second Cashfree order');

    // The diner closing the window or a made-up claim does not make the order paid: only Cashfree can.
    const early = await verify(order);
    assert.equal(early.status, 200);
    assert.equal(early.body.data.payment_status, 'unpaid');

    cfOrders.get(a.body.data.cashfree_order_id).status = 'PAID';
    const paid = await verify(order);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.data.payment_status, 'paid');
    assert.equal(paid.body.data.payment_method, 'cashfree');
    assert.equal(paid.body.data.status, 'accepted', 'paying online accepts the order');
    const row = await db.query(`SELECT status, provider_payment_id FROM payments WHERE provider = 'cashfree' AND provider_order_id = $1`, [a.body.data.cashfree_order_id]);
    assert.deepEqual(row.rows[0], { status: 'paid', provider_payment_id: '5551234' });

    assert.equal((await verify(order)).status, 200, 'verifying again is harmless');
    assert.equal((await start(order)).status, 409, 'an already paid order cannot be paid again');
  });

  it('does not mark an order paid when the amount Cashfree took is different', async () => {
    const order = await place('online');
    const a = await start(order);
    const cf = cfOrders.get(a.body.data.cashfree_order_id);
    cf.status = 'PAID';
    cf.amount = 1;
    const r = await verify(order);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'PAYMENT_AMOUNT_MISMATCH');
    assert.equal((await status(order)).payment_status, 'unpaid');
  });

  it('starts a fresh Cashfree order when the earlier one has expired', async () => {
    const order = await place('online');
    const a = await start(order);
    cfOrders.get(a.body.data.cashfree_order_id).status = 'EXPIRED';
    const b = await start(order);
    assert.equal(b.status, 200);
    assert.notEqual(b.body.data.cashfree_order_id, a.body.data.cashfree_order_id);
    const old = await db.query(`SELECT status FROM payments WHERE provider_order_id = $1`, [a.body.data.cashfree_order_id]);
    assert.equal(old.rows[0].status, 'failed');
  });

  it('shows Cashfree money in the dashboard split, the sales report and the receipt', async () => {
    const d = (await api('GET', '/api/admin/dashboard/overview', { token })).body.data;
    assert.equal(d.payment_methods.find((m) => m.method === 'cashfree').amount, 80);
    assert.equal(d.today_revenue, 80);
    const r = (await api('GET', '/api/admin/reports/summary', { token })).body.data;
    assert.equal(r.sales.by_method.find((m) => m.method === 'cashfree').amount, 80);
  });

  it('refuses to switch Cashfree on when the product does not offer it', async () => {
    config.paymentMethods = new Set(['upi', 'cash', 'razorpay']);
    try {
      assert.equal((await put({ cashfree_enabled: true })).status, 400);
      assert.equal((await api('GET', `/api/public/t/${qr}`)).body.data.payment_options.cashfree, false);
    } finally {
      config.paymentMethods = new Set(['upi', 'cash', 'razorpay', 'cashfree']);
    }
  });
});

describe('online payment by scanning a QR (Razorpay)', () => {
  let token;
  let qr;
  let itemId;
  const put = (body) => api('PUT', '/api/admin/payment-settings', { token, body });
  const place = async () => {
    const r = await api('POST', `/api/public/t/${qr}/orders`, { body: { pay_pref: 'online', items: [{ item_id: itemId, quantity: 3, option_ids: [] }] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };
  const startQr = (order) => api('POST', `/api/public/orders/${order.token}/razorpay-qr`);
  const verifyQr = (order) => api('POST', `/api/public/orders/${order.token}/razorpay-qr/verify`);

  before(async () => {
    token = (await api('POST', '/api/auth/signup', { body: { name: 'QR Cafe', email: 'qr.cafe@example.test', password: 'a-long-enough-password' } })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data.id;
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'Q1', capacity: 2 } })).body.data.qr_url.split('/').pop();
  });

  it('is not offered until the restaurant has Razorpay keys', async () => {
    const order = await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: itemId, quantity: 1, option_ids: [] }] } });
    const r = await startQr(order.body.data);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'RAZORPAY_NOT_CONFIGURED');
    assert.equal((await put({ razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' })).status, 200);
  });

  it('makes one QR code for the order (reused on reload) and marks it paid only when Razorpay shows the money', async () => {
    const order = await place();
    const a = await startQr(order);
    assert.equal(a.status, 200);
    assert.match(a.body.data.qr_id, /^qr_MOCK/);
    assert.match(a.body.data.image_url, /^https:\/\/rzp\.test\/qr_MOCK\d+\.png$/);
    assert.equal(a.body.data.amount, 60);
    const created = razorpayCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/payments/qr_codes')).at(-1);
    assert.equal(created.body.type, 'upi_qr');
    assert.equal(created.body.usage, 'single_use');
    assert.equal(created.body.fixed_amount, true);
    assert.equal(created.body.payment_amount, 6000);
    assert.ok(created.body.close_by > Date.now() / 1000 + 3600);

    const before = razorpayCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/payments/qr_codes')).length;
    const b = await startQr(order);
    assert.equal(b.body.data.qr_id, a.body.data.qr_id, 'the same QR on a reload');
    assert.equal(razorpayCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/payments/qr_codes')).length, before, 'no second QR');

    // Nobody paid yet, and a payment of another amount does not count.
    assert.equal((await verifyQr(order)).body.data.payment_status, 'unpaid');
    qrCodes.get(a.body.data.qr_id).payments.push({ id: 'pay_QRSHORT0001', amount: 100, status: 'captured' });
    assert.equal((await verifyQr(order)).body.data.payment_status, 'unpaid');
    qrCodes.get(a.body.data.qr_id).payments.push({ id: 'pay_QRFAILED001', amount: 6000, status: 'failed' });
    assert.equal((await verifyQr(order)).body.data.payment_status, 'unpaid', 'a failed payment is not money');

    qrCodes.get(a.body.data.qr_id).payments.push({ id: 'pay_QRPAID00001', amount: 6000, status: 'captured' });
    const paid = await verifyQr(order);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.data.payment_status, 'paid');
    assert.equal(paid.body.data.payment_method, 'razorpay');
    assert.equal(paid.body.data.status, 'accepted', 'paying online accepts the order');
    const row = await db.query(`SELECT status, provider_payment_id FROM payments WHERE provider_order_id = $1`, [a.body.data.qr_id]);
    assert.deepEqual(row.rows[0], { status: 'paid', provider_payment_id: 'pay_QRPAID00001' });

    assert.equal((await verifyQr(order)).status, 200, 'checking again is harmless');
    assert.equal((await startQr(order)).status, 409, 'an already paid order needs no QR');
  });

  it('makes a new QR when the earlier one has closed', async () => {
    const order = await place();
    const a = await startQr(order);
    qrCodes.get(a.body.data.qr_id).status = 'closed';
    const b = await startQr(order);
    assert.equal(b.status, 200);
    assert.notEqual(b.body.data.qr_id, a.body.data.qr_id);
  });

  it('tells the diner to use another way when Razorpay refuses (for example UPI QR is not switched on)', async () => {
    const order = await place();
    assert.equal((await put({ razorpay_key_id: 'rzp_test_wrongkey1234', razorpay_key_secret: 'wrong-secret-1' })).status, 200);
    try {
      const r = await startQr(order);
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'RAZORPAY_QR_UNAVAILABLE');
      assert.match(r.body.error.message, /Pay online/);
    } finally {
      await put({ razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' });
    }
  });
});

describe('veg / non-veg marker on dishes', () => {
  let token;
  let categoryId;
  let qr;
  const post = (body) => api('POST', '/api/admin/items', { token, body: { category_id: categoryId, price: 50, ...body } });
  const patch = (id, body) => api('PATCH', `/api/admin/items/${id}`, { token, body });

  before(async () => {
    token = (await api('POST', '/api/auth/signup', { body: { name: 'Diet Cafe', email: 'diet.cafe@example.test', password: 'a-long-enough-password' } })).body.data.token;
    categoryId = (await api('POST', '/api/admin/categories', { token, body: { name: 'Mains' } })).body.data.id;
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'D1', capacity: 2 } })).body.data.qr_url.split('/').pop();
  });

  it('is not marked unless the restaurant marks it (we never guess)', async () => {
    const r = await post({ name: 'Mystery dish' });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.diet, null);
  });

  it('stores each kind and refuses anything else', async () => {
    for (const diet of ['veg', 'egg', 'nonveg', 'jain']) {
      const r = await post({ name: `Dish ${diet}`, diet });
      assert.equal(r.status, 201, diet);
      assert.equal(r.body.data.diet, diet);
    }
    for (const diet of ['vegan', 'VEG', '', 7]) assert.equal((await post({ name: 'Bad', diet })).status, 400, String(diet));
  });

  it('changes and clears the marker, and leaves it alone when it is not sent', async () => {
    const id = (await post({ name: 'Paneer', diet: 'veg' })).body.data.id;
    assert.equal((await patch(id, { diet: 'jain' })).body.data.diet, 'jain');
    assert.equal((await patch(id, { name: 'Paneer Tikka' })).body.data.diet, 'jain', 'an edit that does not mention it keeps it');
    assert.equal((await patch(id, { diet: null })).body.data.diet, null, 'null clears it');
    assert.equal((await patch(id, { diet: 'tofu' })).status, 400);
  });

  it('shows the marker to diners on the menu', async () => {
    const menu = await api('GET', `/api/public/t/${qr}`);
    assert.equal(menu.status, 200);
    const byName = Object.fromEntries(menu.body.data.items.map((i) => [i.name, i.diet]));
    assert.equal(byName['Mystery dish'], null);
    assert.equal(byName['Dish nonveg'], 'nonveg');
    assert.equal(byName['Dish egg'], 'egg');
    assert.equal(byName['Dish jain'], 'jain');
  });

  it('marks the demo menus: vegetarian, apart from one egg dish and one non-veg dish', async () => {
    const { seed } = await import('../src/seed.js');
    const demoDb = await createDb({ pgliteDir: 'memory' });
    try {
      await migrate(demoDb, { log: () => {} });
      await seed(demoDb, { log: () => {} });
      const { rows } = await demoDb.query(`SELECT diet, count(*)::int AS n FROM items GROUP BY diet ORDER BY diet`);
      const counts = Object.fromEntries(rows.map((r) => [r.diet ?? 'none', r.n]));
      assert.equal(counts.none, undefined, 'every demo dish is marked');
      assert.equal(counts.nonveg, 1);
      assert.equal(counts.egg, 1);
      assert.ok(counts.veg > 20);
    } finally {
      await demoDb.close();
    }
  });
});

describe('order ready (the diner is told the food is ready)', () => {
  let token;
  let qr;
  let itemId;
  const place = async () => (await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: itemId, quantity: 1, option_ids: [] }] } })).body.data;
  const adminId = async (publicOrder) => (await api('GET', '/api/admin/orders?status=active', { token })).body.data.find((o) => o.total === publicOrder.total && o.status !== 'completed')?.id;
  const ready = (id) => api('POST', `/api/admin/orders/${id}/ready`, { token });

  before(async () => {
    token = (await api('POST', '/api/auth/signup', { body: { name: 'Ready Cafe', email: 'ready.cafe@example.test', password: 'a-long-enough-password' } })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data.id;
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'R1', capacity: 2 } })).body.data.qr_url.split('/').pop();
  });

  it('only an accepted order can be marked ready', async () => {
    const order = await place();
    const id = await adminId(order);
    const early = await ready(id);
    assert.equal(early.status, 409, 'still pending');
    assert.equal(early.body.error.code, 'INVALID_TRANSITION');
    assert.equal((await api('POST', '/api/admin/orders/999999/ready', { token })).status, 404);
    assert.equal((await api('POST', `/api/admin/orders/${id}/ready`)).status, 401);
  });

  it('marks it ready once, tells the diner, and keeps the order accepted', async () => {
    const order = await place();
    const id = await adminId(order);
    assert.equal((await api('PATCH', `/api/admin/orders/${id}/status`, { token, body: { status: 'accepted' } })).status, 200);
    assert.equal((await api('GET', `/api/public/orders/${order.token}`)).body.data.ready_at, null);

    const r = await ready(id);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.ready_at);
    assert.equal(r.body.data.status, 'accepted');
    const diner = (await api('GET', `/api/public/orders/${order.token}`)).body.data;
    assert.equal(diner.status, 'accepted');
    assert.equal(diner.ready_at, r.body.data.ready_at);

    const again = await ready(id);
    assert.equal(again.status, 200, 'pressing it twice is harmless');
    assert.equal(again.body.data.ready_at, r.body.data.ready_at, 'the time does not move');
  });

  it("does not let one restaurant mark another's order", async () => {
    const order = await place();
    const id = await adminId(order);
    await api('PATCH', `/api/admin/orders/${id}/status`, { token, body: { status: 'accepted' } });
    const other = (await api('POST', '/api/auth/signup', { body: { name: 'Other Cafe', email: 'other.ready@example.test', password: 'a-long-enough-password' } })).body.data.token;
    assert.equal((await api('POST', `/api/admin/orders/${id}/ready`, { token: other })).status, 404);
  });
});

describe('table code (fake-order guard)', () => {
  let token;
  let table;
  let qr;
  let itemId;
  const order = (body = {}) => api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: itemId, quantity: 1, option_ids: [] }], ...body } });
  const setMode = (mode) => api('PATCH', '/api/admin/vendor', { token, body: { table_code_mode: mode } });
  const latest = async () => (await api('GET', '/api/admin/orders?per_page=1', { token })).body.data[0];

  before(async () => {
    token = (await api('POST', '/api/auth/signup', { body: { name: 'Code Cafe', email: 'code.cafe@example.test', password: 'a-long-enough-password' } })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data.id;
    table = (await api('POST', '/api/admin/tables', { token, body: { number: 'K1', capacity: 2 } })).body.data;
    qr = table.qr_url.split('/').pop();
  });

  it('gives every table its own 4-digit code, and keeps it off the diner menu', async () => {
    assert.match(table.code, /^\d{4}$/);
    const other = (await api('POST', '/api/admin/tables', { token, body: { number: 'K2', capacity: 2 } })).body.data;
    assert.match(other.code, /^\d{4}$/);
    const menu = await api('GET', `/api/public/t/${qr}`);
    assert.equal(menu.body.data.table.code_mode, 'off');
    assert.ok(!JSON.stringify(menu.body).includes(table.code) || table.code.length < 5, 'the menu never carries the code itself');
    assert.equal(menu.body.data.table.code, undefined);
  });

  it('takes orders without a code while the restaurant has not switched the guard on', async () => {
    assert.equal((await api('GET', '/api/auth/me', { token })).body.data.table_code_mode, 'off');
    const placed = await order();
    assert.equal(placed.status, 201);
    assert.equal((await latest()).table_code_verified, false);
    // A code sent while the guard is off is ignored, not checked.
    assert.equal((await order({ table_code: '0000' })).status, 201);
  });

  it('rejects a mode that is not off, optional or required', async () => {
    assert.equal((await setMode('sometimes')).status, 400);
    assert.equal((await api('PATCH', '/api/admin/vendor', { token, body: { table_code_mode: true } })).status, 400);
  });

  it('optional: the code can be left out, a wrong one is refused, a right one marks the order verified', async () => {
    const on = await setMode('optional');
    assert.equal(on.status, 200);
    assert.equal(on.body.data.table_code_mode, 'optional');
    assert.equal((await api('GET', `/api/public/t/${qr}`)).body.data.table.code_mode, 'optional');

    const skipped = await order();
    assert.equal(skipped.status, 201);
    assert.equal((await latest()).table_code_verified, false, 'no code typed: not verified');
    const blank = await order({ table_code: '' });
    assert.equal(blank.status, 201, 'an empty box counts as no code');

    const wrong = await order({ table_code: table.code === '0000' ? '1111' : '0000' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, 'TABLE_CODE_WRONG');
    assert.match(wrong.body.error.message, /clear the box/i);

    const right = await order({ table_code: table.code });
    assert.equal(right.status, 201);
    assert.equal((await latest()).table_code_verified, true, 'right code typed: verified');
  });

  it('refuses an order with no code or a wrong code once the guard is on', async () => {
    const on = await setMode('required');
    assert.equal(on.status, 200);
    assert.equal(on.body.data.table_code_mode, 'required');
    assert.equal((await api('GET', `/api/public/t/${qr}`)).body.data.table.code_mode, 'required');

    const none = await order();
    assert.equal(none.status, 403);
    assert.equal(none.body.error.code, 'TABLE_CODE_REQUIRED');
    const wrong = await order({ table_code: table.code === '0000' ? '1111' : '0000' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, 'TABLE_CODE_WRONG');
    assert.equal((await order({ table_code: 'abcd' })).status, 403);
  });

  it('takes the order with the right code', async () => {
    const ok = await order({ table_code: table.code });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.table_number, 'K1');
    assert.equal((await latest()).table_code_verified, true, 'a required code that was accepted is verified');
  });

  it('changes the code on request, so the old one stops working', async () => {
    const fresh = await api('POST', `/api/admin/tables/${table.id}/code`, { token });
    assert.equal(fresh.status, 200);
    assert.match(fresh.body.data.code, /^\d{4}$/);
    if (fresh.body.data.code !== table.code) assert.equal((await order({ table_code: table.code })).status, 403, 'the old code');
    assert.equal((await order({ table_code: fresh.body.data.code })).status, 201);
    assert.equal((await api('POST', '/api/admin/tables/999999/code', { token })).status, 404);
    assert.equal((await api('POST', `/api/admin/tables/${table.id}/code`)).status, 401);
  });

  it("does not let one restaurant read or change another's table code", async () => {
    const other = (await api('POST', '/api/auth/signup', { body: { name: 'Other Code Cafe', email: 'other.code@example.test', password: 'a-long-enough-password' } })).body.data.token;
    assert.equal((await api('POST', `/api/admin/tables/${table.id}/code`, { token: other })).status, 404);
    const list = await api('GET', '/api/admin/tables', { token: other });
    assert.ok(!JSON.stringify(list.body).includes(table.qr_url));
    assert.equal((await setMode('off')).body.data.table_code_mode, 'off');
    assert.equal((await order()).status, 201, 'off again: no code needed');
  });
});

describe('call the waiter / ask for the bill', () => {
  let token;
  let qr;
  let tableId;
  const ask = (kind, tk = qr) => api('POST', `/api/public/t/${tk}/requests`, { body: { kind } });
  const open = () => api('GET', '/api/admin/requests', { token });

  before(async () => {
    token = (await api('POST', '/api/auth/signup', { body: { name: 'Call Cafe', email: 'call.cafe@example.test', password: 'a-long-enough-password' } })).body.data.token;
    const t = (await api('POST', '/api/admin/tables', { token, body: { number: 'W1', capacity: 2 } })).body.data;
    tableId = t.id;
    qr = t.qr_url.split('/').pop();
  });

  it('has nothing open to begin with', async () => {
    assert.deepEqual((await open()).body.data, []);
    assert.deepEqual((await api('GET', `/api/public/t/${qr}/requests`)).body.data, { waiter: false, bill: false });
  });

  it('lets a diner call the waiter and ask for the bill, and staff see both', async () => {
    const w = await ask('waiter');
    assert.equal(w.status, 201);
    assert.equal(w.body.data.already_asked, false);
    assert.equal(w.body.data.waiter, true);
    const b = await ask('bill');
    assert.equal(b.status, 201);
    assert.equal(b.body.data.bill, true);
    const list = (await open()).body.data;
    assert.deepEqual(list.map((r) => [r.kind, r.table_number]), [['waiter', 'W1'], ['bill', 'W1']]);
    assert.deepEqual((await api('GET', `/api/public/t/${qr}/requests`)).body.data, { waiter: true, bill: true });
  });

  it('does not pile up when the diner taps again', async () => {
    const again = await ask('waiter');
    assert.equal(again.status, 200);
    assert.equal(again.body.data.already_asked, true);
    assert.equal((await open()).body.data.length, 2);
  });

  it('refuses anything that is not one of the two kinds, or an unknown table', async () => {
    assert.equal((await ask('pizza')).status, 400);
    assert.equal((await api('POST', `/api/public/t/${qr}/requests`, { body: {} })).status, 400);
    assert.equal((await ask('waiter', 'f'.repeat(32))).status, 404);
  });

  it('lets staff mark one done (twice is fine), and the diner can ask again', async () => {
    const [waiter] = (await open()).body.data;
    const done = await api('POST', `/api/admin/requests/${waiter.id}/done`, { token });
    assert.equal(done.status, 200);
    assert.equal((await api('POST', `/api/admin/requests/${waiter.id}/done`, { token })).status, 200);
    assert.deepEqual((await open()).body.data.map((r) => r.kind), ['bill']);
    assert.equal((await ask('waiter')).status, 201, 'a fresh request once the old one is done');
  });

  it("keeps one restaurant's requests from another", async () => {
    const other = (await api('POST', '/api/auth/signup', { body: { name: 'Other Call Cafe', email: 'other.call@example.test', password: 'a-long-enough-password' } })).body.data.token;
    assert.deepEqual((await api('GET', '/api/admin/requests', { token: other })).body.data, []);
    const [first] = (await open()).body.data;
    assert.equal((await api('POST', `/api/admin/requests/${first.id}/done`, { token: other })).status, 404);
    assert.equal((await api('GET', '/api/admin/requests')).status, 401);
  });

  it('disappears with the table', async () => {
    assert.equal((await api('DELETE', `/api/admin/tables/${tableId}`, { token })).status, 204);
    assert.deepEqual((await open()).body.data, []);
  });
});

describe("table bill (one payment for everything a table ordered)", () => {
  let token;
  let table;
  let qr;
  let itemId;
  const order = async () => (await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: itemId, quantity: 1, option_ids: [] }] } })).body.data;
  const bill = () => api('GET', `/api/admin/tables/${table.id}/bill`, { token });
  const settle = (method) => api('POST', `/api/admin/tables/${table.id}/settle`, { token, body: { method } });

  before(async () => {
    token = (await api('POST', '/api/auth/signup', { body: { name: 'Bill Cafe', email: 'bill.cafe@example.test', password: 'a-long-enough-password' } })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 100 } })).body.data.id;
    table = (await api('POST', '/api/admin/tables', { token, body: { number: 'B1', capacity: 4 } })).body.data;
    qr = table.qr_url.split('/').pop();
  });

  it('is empty before anyone orders, and refuses to settle nothing', async () => {
    const r = await bill();
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.data.count, r.body.data.total, r.body.data.table_number], [0, 0, 'B1']);
    const s = await settle('cash');
    assert.equal(s.status, 409);
    assert.equal(s.body.error.code, 'NOTHING_TO_PAY');
  });

  it('adds up every unpaid order of the table (not cancelled ones, not other tables)', async () => {
    await order();
    await order();
    const third = await order();
    const list = (await api('GET', '/api/admin/orders?status=active', { token })).body.data;
    const thirdId = list.find((o) => o.id === Math.max(...list.map((x) => x.id))).id;
    assert.equal((await api('PATCH', `/api/admin/orders/${thirdId}/status`, { token, body: { status: 'cancelled' } })).status, 200);
    assert.ok(third.token);

    const other = (await api('POST', '/api/admin/tables', { token, body: { number: 'B2', capacity: 2 } })).body.data;
    await api('POST', `/api/public/t/${other.qr_url.split('/').pop()}/orders`, { body: { items: [{ item_id: itemId, quantity: 1, option_ids: [] }] } });

    const r = (await bill()).body.data;
    assert.equal(r.count, 2);
    assert.equal(r.total, 200, 'two orders of 100 (a new restaurant charges no tax); the cancelled one and the other table are left out');
  });

  it('settles them all in one go by cash, once', async () => {
    const before = (await bill()).body.data;
    const s = await settle('cash');
    assert.equal(s.status, 200);
    assert.equal(s.body.data.settled, before.count);
    assert.equal(s.body.data.total, before.total);
    const after = (await bill()).body.data;
    assert.deepEqual([after.count, after.total], [0, 0]);
    const paid = (await api('GET', '/api/admin/orders?payment=paid', { token })).body.data.filter((o) => o.table_number === 'B1');
    assert.equal(paid.length, before.count);
    assert.ok(paid.every((o) => o.payment_method === 'cash'));
    assert.equal((await settle('cash')).status, 409, 'nothing left to settle');
  });

  it('can settle by UPI, and refuses a method the product does not offer', async () => {
    await order();
    assert.equal((await settle('bitcoin')).status, 400);
    config.paymentMethods = new Set(['upi']);
    try {
      const cash = await settle('cash');
      assert.equal(cash.status, 409);
      assert.equal(cash.body.error.code, 'METHOD_NOT_AVAILABLE');
    } finally {
      config.paymentMethods = new Set(['upi', 'cash', 'razorpay', 'cashfree']);
    }
    const upi = await settle('upi');
    assert.equal(upi.status, 200);
    assert.equal(upi.body.data.method, 'upi');
  });

  it("does not let another restaurant see or settle this table's bill", async () => {
    await order();
    const other = (await api('POST', '/api/auth/signup', { body: { name: 'Other Bill Cafe', email: 'other.bill@example.test', password: 'a-long-enough-password' } })).body.data.token;
    assert.equal((await api('GET', `/api/admin/tables/${table.id}/bill`, { token: other })).status, 404);
    assert.equal((await api('POST', `/api/admin/tables/${table.id}/settle`, { token: other, body: { method: 'cash' } })).status, 404);
    assert.equal((await api('GET', `/api/admin/tables/${table.id}/bill`)).status, 401);
    assert.equal((await bill()).body.data.count, 1, 'untouched');
  });
});

describe('refund of an online payment', () => {
  let token;
  let qr;
  let itemId;
  const put = (body) => api('PUT', '/api/admin/payment-settings', { token, body });
  const placeOnline = async () => (await api('POST', `/api/public/t/${qr}/orders`, { body: { pay_pref: 'online', items: [{ item_id: itemId, quantity: 1, option_ids: [] }] } })).body.data;
  // The newest order of this restaurant, as the admin sees it (each test places one order right before asking).
  const adminOrder = async () => {
    const list = (await api('GET', '/api/admin/orders?per_page=100', { token })).body.data;
    return list.reduce((a, b) => (b.id > a.id ? b : a));
  };
  const refund = (id) => api('POST', `/api/admin/orders/${id}/refund`, { token });
  // pays an order through the QR route of the fake Razorpay, so it has a real payment id
  const payOnline = async (diner) => {
    const started = await api('POST', `/api/public/orders/${diner.token}/razorpay-qr`);
    qrCodes.get(started.body.data.qr_id).payments.push({ id: `pay_REFUND${qrCodes.size}${Date.now() % 100000}`, amount: Math.round(diner.total * 100), status: 'captured' });
    return (await api('POST', `/api/public/orders/${diner.token}/razorpay-qr/verify`)).body.data;
  };

  before(async () => {
    token = (await api('POST', '/api/auth/signup', { body: { name: 'Refund Cafe', email: 'refund.cafe@example.test', password: 'a-long-enough-password' } })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 40 } })).body.data.id;
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'F1', capacity: 2 } })).body.data.qr_url.split('/').pop();
    assert.equal((await put({ razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' })).status, 200);
  });

  it('refuses to refund an order nobody paid, or a cash order', async () => {
    const diner = await placeOnline();
    const mine = await adminOrder();
    const unpaid = await refund(mine.id);
    assert.equal(unpaid.status, 409);
    assert.equal(unpaid.body.error.code, 'NOT_PAID');
    assert.equal((await api('POST', `/api/admin/orders/${mine.id}/cash-payment`, { token })).status, 200);
    const cash = await refund(mine.id);
    assert.equal(cash.status, 409);
    assert.equal(cash.body.error.code, 'REFUND_MANUAL');
    assert.equal((await api('POST', '/api/admin/orders/999999/refund', { token })).status, 404);
    assert.equal((await api('POST', `/api/admin/orders/${mine.id}/refund`)).status, 401);
  });

  it('refunds a paid online order in full, cancels it, and takes it out of the money counted', async () => {
    const diner = await placeOnline();
    const paid = await payOnline(diner);
    assert.equal(paid.payment_status, 'paid');
    const mine = await adminOrder();
    const before = (await api('GET', '/api/admin/dashboard/overview', { token })).body.data.today_revenue;

    const asked = razorpayRefunds.length;
    const r = await refund(mine.id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.payment_status, 'refunded');
    assert.equal(r.body.data.status, 'cancelled', 'not served yet, so the order is cancelled too');
    assert.equal(razorpayRefunds.length, asked + 1);
    assert.equal(razorpayRefunds.at(-1).amount, Math.round(diner.total * 100), 'the whole amount');

    const row = await db.query(`SELECT status, refund_id FROM payments WHERE order_id = $1 AND provider = 'razorpay'`, [mine.id]);
    assert.equal(row.rows[0].status, 'refunded');
    assert.match(row.rows[0].refund_id, /^rfnd_MOCK/);
    const after = (await api('GET', '/api/admin/dashboard/overview', { token })).body.data.today_revenue;
    assert.equal(Math.round((before - after) * 100), Math.round(diner.total * 100), 'the refunded money is no longer revenue');

    const seen = (await api('GET', `/api/public/orders/${diner.token}`)).body.data;
    assert.equal(seen.payment_status, 'refunded');
    assert.equal(seen.status, 'cancelled');
  });

  it('refunds only once', async () => {
    const diner = await placeOnline();
    await payOnline(diner);
    const mine = await adminOrder();
    assert.equal((await refund(mine.id)).status, 200);
    const again = await refund(mine.id);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_REFUNDED');
  });

  it("does not let another restaurant refund this restaurant's order", async () => {
    const diner = await placeOnline();
    await payOnline(diner);
    const mine = await adminOrder();
    const other = (await api('POST', '/api/auth/signup', { body: { name: 'Other Refund Cafe', email: 'other.refund@example.test', password: 'a-long-enough-password' } })).body.data.token;
    assert.equal((await api('POST', `/api/admin/orders/${mine.id}/refund`, { token: other })).status, 404);
  });
});

describe('restaurant logo', () => {
  let token;
  let qr;
  let otherToken;
  const put = (raw, type = 'image/png', tok = token) => api('PUT', '/api/admin/vendor/logo', { token: tok, raw, headers: { 'Content-Type': type } });

  before(async () => {
    const su = await api('POST', '/api/auth/signup', { body: { name: 'Logo Cafe', email: 'logo.cafe@example.test', password: 'a-long-enough-password' } });
    token = su.body.data.token;
    assert.equal(su.body.data.vendor.logo_url, null, 'no logo to begin with');
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'L1', capacity: 2 } })).body.data.qr_url.split('/').pop();
    otherToken = (await api('POST', '/api/auth/signup', { body: { name: 'No Logo Cafe', email: 'no.logo@example.test', password: 'a-long-enough-password' } })).body.data.token;
  });

  it('refuses anything that is not a real image', async () => {
    assert.equal((await put(Buffer.from('not an image'))).status, 415);
    assert.equal((await put(PNG_1X1, 'text/plain')).status, 415, 'only image types are accepted');
    assert.equal((await put(Buffer.alloc(600 * 1024, 1))).status, 413, 'over the size cap');
    assert.equal((await api('GET', '/api/auth/me', { token })).body.data.logo_url, null, 'a refused upload changes nothing');
    assert.equal((await api('PUT', '/api/admin/vendor/logo', { raw: PNG_1X1, headers: { 'Content-Type': 'image/png' } })).status, 401, 'needs a login');
  });

  it('stores the logo and serves it publicly with caching', async () => {
    const up = await put(PNG_1X1);
    assert.equal(up.status, 200);
    assert.match(up.body.data.logo_url, /^\/api\/public\/vendors\/\d+\/logo\?v=1$/);
    const logo = await api('GET', up.body.data.logo_url);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.match(logo.headers.get('cache-control'), /immutable/);
    assert.ok(logo.body.equals(PNG_1X1));
    assert.equal((await api('GET', '/api/auth/me', { token })).body.data.logo_url, up.body.data.logo_url);
  });

  it('shows the logo to diners on the menu and the order page, and not on another restaurant', async () => {
    const menu = await api('GET', `/api/public/t/${qr}`);
    assert.match(menu.body.data.vendor.logo_url, /\/logo\?v=1$/);
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    const item = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data;
    const order = (await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: item.id, quantity: 1, option_ids: [] }] } })).body.data;
    assert.equal(order.vendor.logo_url, menu.body.data.vendor.logo_url);
    assert.equal((await api('GET', '/api/auth/me', { token: otherToken })).body.data.logo_url, null);
  });

  it('gives a replaced logo a new URL, and removes it on request', async () => {
    const again = await put(PNG_1X1);
    assert.match(again.body.data.logo_url, /\?v=2$/);
    const del = await api('DELETE', '/api/admin/vendor/logo', { token });
    assert.equal(del.status, 200);
    assert.equal(del.body.data.logo_url, null);
    assert.equal((await api('GET', again.body.data.logo_url)).status, 404, 'the stored image is gone');
    assert.equal((await api('GET', `/api/public/t/${qr}`)).body.data.vendor.logo_url, null);
    assert.equal((await api('GET', '/api/public/vendors/abc/logo')).status, 404);
  });
});

describe('menu colours (theme)', () => {
  it('starts with the default colours and lets the vendor change them', async () => {
    const me = await api('GET', '/api/auth/me', { token: s.token });
    assert.deepEqual(me.body.data.theme, { primary: '#2f6f62', accent: '#e8872a' });
    const patched = await api('PATCH', '/api/admin/vendor', { token: s.token, body: { theme_primary: '#B91C1C' } });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.data.theme, { primary: '#b91c1c', accent: '#e8872a' }, 'normalised to lower case; accent untouched');
    assert.equal(patched.body.data.name, 'Spice Hub', 'other fields are untouched');
  });

  it('rejects anything that is not a #rrggbb colour', async () => {
    for (const bad of ['red', '#fff', '#12345g', 'rgb(1,2,3)', '']) {
      const r = await api('PATCH', '/api/admin/vendor', { token: s.token, body: { theme_accent: bad } });
      assert.equal(r.status, 400, `"${bad}" should be refused`);
    }
  });

  it('serves the colours to the customer menu and order pages', async () => {
    const menu = await api('GET', `/api/public/t/${s.qrToken}`);
    assert.deepEqual(menu.body.data.vendor.theme, { primary: '#b91c1c', accent: '#e8872a' });
    const order = await api('GET', `/api/public/orders/${s.upiOrder.token}`);
    assert.deepEqual(order.body.data.vendor.theme, { primary: '#b91c1c', accent: '#e8872a' });
  });

  it("does not leak one restaurant's colours into another's", async () => {
    const other = await api('GET', '/api/auth/me', { token: s.otherToken });
    assert.equal(other.body.data.theme.primary, '#2f6f62');
  });
});

describe('cleanup rules', () => {
  it('cancels an unpaid order, and deletes orders and items without breaking history', async () => {
    const o = await api('POST', `/api/public/t/${s.qrToken}/orders`, {
      body: { items: [{ item_id: s.pizzaItem.id, quantity: 1, option_ids: [s.pizzaItem.option_groups[0].options[0].id] }] },
    });
    const id = (await api('GET', '/api/admin/orders?status=pending', { token: s.token })).body.data[0].id;
    const cancelled = await api('PATCH', `/api/admin/orders/${id}/status`, { token: s.token, body: { status: 'cancelled' } });
    assert.equal(cancelled.body.data.status, 'cancelled');
    assert.equal((await api('POST', `/api/admin/orders/${id}/cash-payment`, { token: s.token })).status, 409);
    assert.equal((await api('DELETE', `/api/admin/orders/${id}`, { token: s.token })).status, 204);
    assert.equal((await api('GET', `/api/public/orders/${o.body.data.token}`)).status, 404);

    // Deleting a menu item keeps old orders readable.
    assert.equal((await api('DELETE', `/api/admin/items/${s.pizzaItem.id}`, { token: s.token })).status, 204);
    const old = await api('GET', `/api/admin/orders/${s.orderId}`, { token: s.token });
    assert.equal(old.body.data.items[0].name, 'Margherita');
    assert.equal((await api('DELETE', `/api/admin/tables/${s.table.id}`, { token: s.token })).status, 204);
    assert.equal((await api('GET', `/api/admin/orders/${s.orderId}`, { token: s.token })).body.data.table_number, 'T-01');
  });
});

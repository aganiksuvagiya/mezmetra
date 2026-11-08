// End-to-end API tests against an in-memory PGlite database (same SQL as production Postgres).
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
// The product defaults to UPI only; these tests exercise every method, and the "only UPI" suite below switches it back.
process.env.PAYMENT_METHODS = 'upi,cash,razorpay';

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
    assert.deepEqual(menu.body.data.payment_options, { cash: false, upi: true, razorpay: true });
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
  const ALL = new Set(['upi', 'cash', 'razorpay']);
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
    assert.deepEqual(menu.body.data.payment_options, { cash: false, upi: true, razorpay: false });
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
    assert.deepEqual(ok.body.data.payment_options, { cash: false, upi: true, razorpay: false });
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
    for (const body of [{ cash_enabled: true }, { razorpay_enabled: true }]) {
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
      assert.deepEqual(menu.body.data.payment_options, { cash: false, upi: false, razorpay: false });
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
    assert.deepEqual(d.sales.by_method.map((m) => m.method), ['upi', 'cash', 'razorpay']);
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
    assert.equal(Math.round(dash.weekly_revenue.reduce((n, d) => n + d.revenue, 0) * 100), r.revenue * 100 + realPaid, 'the 7-day chart counts the sample payments');
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

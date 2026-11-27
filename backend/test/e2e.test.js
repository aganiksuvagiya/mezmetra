// End-to-end API tests against an in-memory PGlite database (same SQL as production Postgres).
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
// Every way of paying the product offers.
process.env.PAYMENT_METHODS = 'cash,razorpay,phonepe';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';

const { config } = await import('../src/config.js');
const { createDb } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { csvCell, toCsv } = await import('../src/lib/csv.js');
const { reconcileOnce } = await import('../src/lib/reconcile.js');
const { reconcileRefunds } = await import('../src/lib/refunds.js');
const { createRestaurantAccount } = await import('../src/lib/accounts.js');
const { signToken } = await import('../src/middleware/auth.js');
const { vendorOut } = await import('../src/lib/serialize.js');

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
const rzpTaken = new Map(); // payment id -> the refunds the fake Razorpay holds for it
const rzpRefundPlans = new Map(); // payment id -> { answer: HTTP status to fail with, taken: false when it does not take the refund on }
// What the fake Razorpay says about a payment. One it was not told about is captured, for the last order it was asked to create.
const rzpPayments = new Map(); // payment id -> { status, amount, order_id, captureFails }
let rzpLastAmount = 0;
const qrCodes = new Map(); // fake Razorpay QR code id -> { status, payments: [] }

async function listen(app) {
  return new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
}

// The password behind each test login: the admin sends it when payment keys are changed, and so does this helper (unless a test
// passes `current_password` itself, to try without it or with a wrong one).
const passwords = new Map();

async function api(method, path, { token, body, headers = {}, raw } = {}) {
  if (method === 'PUT' && path === '/api/admin/payment-settings' && body && !('current_password' in body) && passwords.has(token)) {
    body = { ...body, current_password: passwords.get(token) };
  }
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

/**
 * Restaurants are created by the platform owner only (there is no public sign-up). Tests that just need a restaurant to work with make one
 * straight in the database and get a login for it; the owner's own way of adding one is tested in its own describe below.
 */
async function signupAccount({ name, email, password }) {
  const vendor = await createRestaurantAccount(db, { name, email, password });
  const token = signToken(vendor.id);
  passwords.set(token, password);
  return { status: 201, body: { data: { token, vendor: vendorOut(vendor) } } };
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
          if (req.method === 'POST' && path === '/v1/orders') rzpLastAmount = JSON.parse(data).amount;
          const one = path.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)(\/capture)?$/);
          if (one) {
            const payment = rzpPayments.get(one[1]) ?? { status: 'captured', amount: rzpLastAmount, order_id: 'order_MOCK123456' };
            if (one[2]) {
              if (payment.captureFails) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: { description: 'Capture failed' } }));
              }
              payment.status = 'captured';
            }
            const { captureFails: _, ...shown } = payment;
            return res.end(JSON.stringify({ id: one[1], entity: 'payment', currency: 'INR', ...shown }));
          }
          const refund = path.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)\/refund$/);
          if (req.method === 'POST' && refund) {
            razorpayRefunds.push({ payment: refund[1], amount: JSON.parse(data).amount });
            const made = { id: `rfnd_MOCK${razorpayRefunds.length}`, entity: 'refund', payment_id: refund[1], amount: JSON.parse(data).amount, status: 'processed' };
            const plan = rzpRefundPlans.get(refund[1]);
            if (plan?.taken !== false) rzpTaken.set(refund[1], [...(rzpTaken.get(refund[1]) ?? []), made]);
            if (plan?.answer) {
              res.statusCode = plan.answer;
              return res.end(JSON.stringify({ error: { description: 'planned failure' } }));
            }
            return res.end(JSON.stringify(made));
          }
          const taken = path.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)\/refunds$/);
          if (taken) return res.end(JSON.stringify({ entity: 'collection', items: rzpTaken.get(taken[1]) ?? [] }));
          const closing = path.match(/^\/v1\/payments\/qr_codes\/(qr_[A-Za-z0-9]+)\/close$/);
          if (req.method === 'POST' && closing) {
            if (qrCodes.has(closing[1])) qrCodes.get(closing[1]).status = 'closed';
            return res.end(JSON.stringify({ id: closing[1], status: 'closed' }));
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

  it('has no public sign-up: the first restaurant is created straight in the database', async () => {
    const closed = await api('POST', '/api/auth/signup', { body: { name: 'Spice Hub', email: 'owner@spice.test', password: 'a-long-enough-password' } });
    assert.equal(closed.status, 404);

    const ok = await signupAccount({ name: 'Spice Hub', email: 'Owner@Spice.test', password: 'a-long-enough-password' });
    assert.ok(ok.body.data.token);
    assert.equal(ok.body.data.vendor.email, 'owner@spice.test');
    assert.equal(ok.body.data.vendor.password_hash, undefined);
    s.token = ok.body.data.token;
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
    const other = await signupAccount({ name: 'Other Cafe', email: 'cafe@other.test', password: 'another-long-password' });
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
    const { photo_url, ...topDish } = d.body.data.top_selling[0];
    assert.deepEqual(topDish, { name: 'Margherita', quantity: 2, revenue: 1419 });
    assert.match(photo_url, /^\/api\/public\/items\/\d+\/photo\?v=\d+$/, 'the dish had a photo uploaded earlier');
    // Two orders placed today (the paid one and this unpaid one); the open one is waiting to be accepted.
    assert.equal(d.body.data.today_orders, 2);
    assert.equal(d.body.data.average_order, 1419);
    assert.deepEqual([d.body.data.live_pending, d.body.data.live_preparing, d.body.data.live_ready], [1, 0, 0]);
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

describe('platform owner (super admin)', () => {
  const OWNER = 'platform.owner@mezmitra.test';
  let ownerToken;
  let ownerId;
  let spiceId;
  const baseItems = () => [{ item_id: s.pizzaItem.id, quantity: 1, option_ids: [s.pizzaItem.option_groups[0].options[0].id] }];

  before(async () => {
    const su = await signupAccount({ name: 'MezMitra HQ', email: OWNER, password: 'a-long-enough-password' });
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
    assert.equal(spice.password_hash, undefined);
    const hq = list.body.data.find((r) => r.id === ownerId);
    assert.equal(hq.is_platform_owner, true);
    assert.equal(hq.orders_total, 0);

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

describe("owner console: a restaurant's page and the owner's actions", () => {
  const OWNER = 'owner.console@mezmitra.test';
  const PASSWORD = 'a-long-enough-password';
  let ownerToken;
  let ownerId;
  const signup = async (name, email) => (await signupAccount({ name, email, password: PASSWORD })).body.data;
  const ownerApi = (method, path, body) => api(method, `/api/platform${path}`, { token: ownerToken, body });

  before(async () => {
    const o = await signup('Console HQ', OWNER);
    ownerToken = o.token;
    ownerId = o.vendor.id;
    config.superAdminEmails = new Set([OWNER]);
  });
  after(() => {
    config.superAdminEmails = new Set();
  });

  it('is only for the owner', async () => {
    const other = await signup('Not The Owner', 'not.owner@mezmitra.test');
    for (const [method, path, body] of [
      ['POST', '/restaurants', { name: 'Sneaky Cafe', email: 'sneaky@mezmitra.test', password: 'another-long-password' }],
      ['GET', '/activity'],
      ['POST', `/restaurants/${other.vendor.id}/profile`, { name: 'Renamed Cafe', email: 'renamed@mezmitra.test' }],
      ['GET', `/restaurants/${other.vendor.id}`],
      ['POST', `/restaurants/${other.vendor.id}/password`, { password: 'another-long-password' }],
      ['POST', `/restaurants/${other.vendor.id}/delete`, { confirm_name: 'Not The Owner' }],
    ]) {
      assert.equal((await api(method, `/api/platform${path}`, { token: other.token, body })).status, 403, `${method} ${path}`);
      assert.equal((await api(method, `/api/platform${path}`, { body })).status, 401, `${method} ${path} (signed out)`);
    }
  });

  it('adds a restaurant: it can sign in at once, shows in the list and in the owner record, and a duplicate email is refused', async () => {
    const bad = [
      [{ name: 'X', email: 'x.cafe@mezmitra.test', password: 'a-long-enough-password' }, 'name'],
      [{ name: 'Added Cafe', email: 'not-an-email', password: 'a-long-enough-password' }, 'email'],
      [{ name: 'Added Cafe', email: 'added.cafe@mezmitra.test', password: 'short' }, 'password'],
    ];
    for (const [body, field] of bad) {
      const r = await ownerApi('POST', '/restaurants', body);
      assert.equal(r.status, 400, field);
      assert.equal(r.body.error.code, 'VALIDATION_ERROR', field);
    }

    const made = await ownerApi('POST', '/restaurants', { name: '  Added Cafe ', email: 'Added.Cafe@Mezmitra.test', password: 'a-long-enough-password' });
    assert.equal(made.status, 201);
    const d = made.body.data;
    assert.equal(d.name, 'Added Cafe');
    assert.equal(d.email, 'added.cafe@mezmitra.test');
    assert.equal(d.status, 'active');
    assert.equal(d.is_platform_owner, false);
    assert.equal(JSON.stringify(made.body).includes('a-long-enough-password'), false, 'the password is never echoed back');
    assert.equal(JSON.stringify(made.body).includes('password_hash'), false);

    // The new restaurant signs in with what the owner chose, and its payment settings exist from the start.
    const login = await api('POST', '/api/auth/login', { body: { email: 'added.cafe@mezmitra.test', password: 'a-long-enough-password' } });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.vendor.name, 'Added Cafe');
    assert.equal((await api('GET', '/api/admin/payment-settings', { token: login.body.data.token })).status, 200);

    const dup = await ownerApi('POST', '/restaurants', { name: 'Another', email: 'ADDED.cafe@mezmitra.test', password: 'another-long-password' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'EMAIL_TAKEN');

    const found = await ownerApi('GET', '/restaurants?q=Added%20Cafe');
    assert.deepEqual(found.body.data.map((r) => r.id), [d.id]);
    const page = await ownerApi('GET', `/restaurants/${d.id}`);
    assert.deepEqual(page.body.data.activity.map((a) => [a.action, a.by]), [['create', OWNER]]);
  });

  it("fixes a restaurant's name and login email; refuses a taken or reserved email and a platform owner's account; records only real changes", async () => {
    const r = await signup('Typo Cafe', 'typo.cafe@mezmitra.test');
    await signup('Taken Cafe', 'taken.cafe@mezmitra.test');
    const url = `/restaurants/${r.vendor.id}/profile`;

    assert.equal((await ownerApi('POST', url, { name: 'F', email: 'fixed.cafe@mezmitra.test' })).status, 400);
    assert.equal((await ownerApi('POST', url, { name: 'Fixed Cafe', email: 'nope' })).status, 400);

    const fixed = await ownerApi('POST', url, { name: ' Fixed Cafe ', email: 'Fixed.Cafe@Mezmitra.test' });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.data.name, 'Fixed Cafe');
    assert.equal(fixed.body.data.email, 'fixed.cafe@mezmitra.test');
    // The new email signs in with the same password; the old one no longer does.
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'fixed.cafe@mezmitra.test', password: PASSWORD } })).status, 200);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'typo.cafe@mezmitra.test', password: PASSWORD } })).status, 401);

    // Saving the same thing again changes nothing and adds nothing to the record.
    assert.equal((await ownerApi('POST', url, { name: 'Fixed Cafe', email: 'fixed.cafe@mezmitra.test' })).status, 200);
    // Only the name changes: the email is not recorded as changed.
    await ownerApi('POST', url, { name: 'Fixed Cafe 2', email: 'fixed.cafe@mezmitra.test' });
    const page = await ownerApi('GET', `/restaurants/${r.vendor.id}`);
    const updates = page.body.data.activity.filter((a) => a.action === 'update');
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0].detail.changes, { name: { from: 'Fixed Cafe', to: 'Fixed Cafe 2' } });
    assert.deepEqual(updates[1].detail.changes, { name: { from: 'Typo Cafe', to: 'Fixed Cafe' }, email: { from: 'typo.cafe@mezmitra.test', to: 'fixed.cafe@mezmitra.test' } });

    const taken = await ownerApi('POST', url, { name: 'Fixed Cafe 2', email: 'TAKEN.cafe@mezmitra.test' });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'EMAIL_TAKEN');

    config.superAdminEmails = new Set([OWNER, 'second.owner@mezmitra.test']);
    const reserved = await ownerApi('POST', url, { name: 'Fixed Cafe 2', email: 'second.owner@mezmitra.test' });
    config.superAdminEmails = new Set([OWNER]);
    assert.equal(reserved.status, 409);
    assert.equal(reserved.body.error.code, 'RESERVED_EMAIL');

    const own = await ownerApi('POST', `/restaurants/${ownerId}/profile`, { name: 'Hijacked HQ', email: 'hijack@mezmitra.test' });
    assert.equal(own.status, 409);
    assert.equal(own.body.error.code, 'CANNOT_EDIT_OWNER');
    assert.equal((await ownerApi('POST', '/restaurants/999999/profile', { name: 'Ghost Cafe', email: 'ghost@mezmitra.test' })).status, 404);
  });

  it("lists everything the owner did across all restaurants, newest first, filterable, and still reads right after a restaurant is deleted", async () => {
    const r = await signup('Gone Cafe', 'gone.cafe@mezmitra.test');
    await ownerApi('POST', `/restaurants/${r.vendor.id}/profile`, { name: 'Gone Cafe', email: 'gone.cafe2@mezmitra.test' });
    await ownerApi('PATCH', `/restaurants/${r.vendor.id}`, { suspended: true, reason: 'test' });
    await ownerApi('POST', `/restaurants/${r.vendor.id}/delete`, { confirm_name: 'Gone Cafe' });

    const all = await ownerApi('GET', '/activity?q=Gone%20Cafe');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.data.map((a) => a.action), ['delete', 'suspend', 'update']);
    assert.ok(all.body.data.every((a) => a.by === OWNER && a.restaurant.name === 'Gone Cafe' && a.restaurant.id === null), 'a deleted restaurant has nothing to link to');
    assert.equal(all.body.data[1].detail.reason, 'test');
    assert.equal(all.body.meta.total, 3);

    const onlyDeletes = await ownerApi('GET', '/activity?action=delete&per_page=1');
    assert.deepEqual(onlyDeletes.body.data.map((a) => a.action), ['delete']);
    assert.equal(onlyDeletes.body.meta.per_page, 1);

    // An entry for a restaurant that still exists links to it.
    const alive = await signup('Alive Cafe', 'alive.cafe@mezmitra.test');
    await ownerApi('PATCH', `/restaurants/${alive.vendor.id}`, { suspended: true });
    const first = (await ownerApi('GET', '/activity?q=alive.cafe')).body.data[0];
    assert.equal(first.restaurant.id, alive.vendor.id);

    assert.equal((await ownerApi('GET', '/activity?action=bogus')).status, 400);
  });

  it("shows one restaurant's profile, payments and recent orders (never a secret)", async () => {
    const r = await signup('Detail Cafe', 'detail.cafe@mezmitra.test');
    const cat = (await api('POST', '/api/admin/categories', { token: r.token, body: { name: 'Tea' } })).body.data;
    const item = (await api('POST', '/api/admin/items', { token: r.token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data;
    const table = (await api('POST', '/api/admin/tables', { token: r.token, body: { number: 'D1', capacity: 2 } })).body.data;
    const qr = table.qr_url.split('/').pop();
    await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: item.id, quantity: 2, option_ids: [] }] } });

    const res = await ownerApi('GET', `/restaurants/${r.vendor.id}`);
    assert.equal(res.status, 200);
    const d = res.body.data;
    assert.equal(d.name, 'Detail Cafe');
    assert.equal(d.email, 'detail.cafe@mezmitra.test');
    assert.equal(d.status, 'active');
    assert.equal(d.is_platform_owner, false);
    assert.equal(d.orders_total, 1);
    assert.equal(d.tables, 1);
    assert.equal(d.items, 1);
    assert.equal(d.categories, 1);
    assert.equal(d.timezone, 'Asia/Kolkata');
    assert.equal(d.recent_orders.length, 1);
    assert.deepEqual([d.recent_orders[0].number, d.recent_orders[0].table_number, d.recent_orders[0].status, d.recent_orders[0].total], [1, 'D1', 'pending', 40]);
    assert.deepEqual(d.activity, []);
    const cash = d.payment.find((p) => p.key === 'cash');
    assert.deepEqual([cash.enabled, cash.configured], [true, true]);
    assert.equal(d.payment.find((p) => p.key === 'razorpay').configured, false);
    const text = JSON.stringify(res.body);
    assert.ok(!/password_hash|secret_enc|key_enc/.test(text), 'no secrets in the answer');
    assert.equal((await ownerApi('GET', '/restaurants/999999')).status, 404);
    assert.equal((await ownerApi('GET', '/restaurants/abc')).status, 404);
  });

  it('sets a new password for a restaurant and signs everyone in it out', async () => {
    const r = await signup('Locked Out Cafe', 'locked.out@mezmitra.test');
    assert.equal((await ownerApi('POST', `/restaurants/${r.vendor.id}/password`, { password: 'short' })).status, 400);
    assert.equal((await ownerApi('POST', `/restaurants/${r.vendor.id}/password`, {})).status, 400);
    // Tokens are stamped to the second, so let the restaurant's login be a second older than the change (as it is in real life).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const set = await ownerApi('POST', `/restaurants/${r.vendor.id}/password`, { password: 'brand-new-password-1' });
    assert.equal(set.status, 200);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'locked.out@mezmitra.test', password: PASSWORD } })).status, 401, 'the old password stops working');
    const login = await api('POST', '/api/auth/login', { body: { email: 'locked.out@mezmitra.test', password: 'brand-new-password-1' } });
    assert.equal(login.status, 200);
    assert.equal((await api('GET', '/api/auth/me', { token: r.token })).status, 401, 'an older session is signed out');
    assert.equal((await api('GET', '/api/auth/me', { token: login.body.data.token })).status, 200);
    const detail = (await ownerApi('GET', `/restaurants/${r.vendor.id}`)).body.data;
    assert.deepEqual(detail.activity.map((a) => [a.action, a.by]), [['set_password', OWNER]]);
    assert.ok(!JSON.stringify(detail).includes('brand-new-password-1'), 'the new password is never recorded');
    // An owner account is changed in Settings, not here.
    const own = await ownerApi('POST', `/restaurants/${ownerId}/password`, { password: 'brand-new-password-2' });
    assert.equal(own.status, 409);
    assert.equal(own.body.error.code, 'CANNOT_RESET_OWNER');
    assert.equal((await ownerApi('POST', '/restaurants/999999/password', { password: 'brand-new-password-1' })).status, 404);
  });

  it("has no way to log in as a restaurant: the owner never gets into a restaurant's admin", async () => {
    const r = await signup('Private Cafe', 'private.cafe@mezmitra.test');
    // The old route is gone: not found for the owner, and still closed to anybody else.
    assert.equal((await ownerApi('POST', `/restaurants/${r.vendor.id}/login-as`, {})).status, 404);
    assert.equal((await api('POST', `/api/platform/restaurants/${r.vendor.id}/login-as`, { token: r.token, body: {} })).status, 403);
    // And the owner's own session sees only the owner's own restaurant in /api/admin, never this one's data.
    await api('POST', '/api/admin/tables', { token: r.token, body: { number: 'PRIVATE-1', capacity: 2 } });
    const ownerTables = (await api('GET', '/api/admin/tables', { token: ownerToken })).body.data;
    assert.equal(ownerTables.some((t) => t.number === 'PRIVATE-1'), false);
    const me = (await api('GET', '/api/auth/me', { token: r.token })).body.data;
    assert.equal('impersonated_by_owner' in me, false);
    // Nothing in the owner's record is called "login_as" any more.
    const detail = (await ownerApi('GET', `/restaurants/${r.vendor.id}`)).body.data;
    assert.deepEqual(detail.activity, []);
  });

  it('records suspend and reactivate in the restaurant\'s activity (only when something changed)', async () => {
    const r = await signup('Activity Cafe', 'activity.cafe@mezmitra.test');
    await ownerApi('PATCH', `/restaurants/${r.vendor.id}`, { suspended: true, reason: 'unpaid' });
    await ownerApi('PATCH', `/restaurants/${r.vendor.id}`, { suspended: true, reason: 'unpaid' }); // nothing changed: not recorded again
    await ownerApi('PATCH', `/restaurants/${r.vendor.id}`, { suspended: false });
    const detail = (await ownerApi('GET', `/restaurants/${r.vendor.id}`)).body.data;
    assert.deepEqual(detail.activity.map((a) => a.action), ['reactivate', 'suspend']);
    assert.equal(detail.activity[1].detail.reason, 'unpaid');
  });

  it('deletes a suspended restaurant with all its data, only when its name is typed', async () => {
    const r = await signup('Doomed Cafe', 'doomed.cafe@mezmitra.test');
    const cat = (await api('POST', '/api/admin/categories', { token: r.token, body: { name: 'Tea' } })).body.data;
    const item = (await api('POST', '/api/admin/items', { token: r.token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data;
    const table = (await api('POST', '/api/admin/tables', { token: r.token, body: { number: 'X1', capacity: 2 } })).body.data;
    const qr = table.qr_url.split('/').pop();
    await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: item.id, quantity: 1, option_ids: [] }] } });
    await api('POST', `/api/public/t/${qr}/requests`, { body: { kind: 'waiter' } });

    const early = await ownerApi('POST', `/restaurants/${r.vendor.id}/delete`, { confirm_name: 'Doomed Cafe' });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'SUSPEND_FIRST');
    await ownerApi('PATCH', `/restaurants/${r.vendor.id}`, { suspended: true });
    const wrong = await ownerApi('POST', `/restaurants/${r.vendor.id}/delete`, { confirm_name: 'doomed' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'NAME_MISMATCH');
    assert.equal((await ownerApi('POST', `/restaurants/${r.vendor.id}/delete`, {})).status, 400);
    assert.equal((await ownerApi('GET', `/restaurants/${r.vendor.id}`)).status, 200, 'still there after the refusals');

    const done = await ownerApi('POST', `/restaurants/${r.vendor.id}/delete`, { confirm_name: 'Doomed Cafe' });
    assert.equal(done.status, 200);
    assert.equal(done.body.data.deleted, true);
    assert.equal((await ownerApi('GET', `/restaurants/${r.vendor.id}`)).status, 404);
    assert.equal((await api('GET', `/api/public/t/${qr}`)).status, 404, 'its QR codes stop working');
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'doomed.cafe@mezmitra.test', password: PASSWORD } })).status, 401);
    const list = (await ownerApi('GET', '/restaurants?q=doomed')).body;
    assert.equal(list.meta.total, 0);
    assert.equal((await ownerApi('POST', `/restaurants/${r.vendor.id}/delete`, { confirm_name: 'Doomed Cafe' })).status, 404);

    // A platform owner can never be deleted.
    await ownerApi('PATCH', `/restaurants/${ownerId}`, { suspended: true });
    const own = await ownerApi('POST', `/restaurants/${ownerId}/delete`, { confirm_name: 'Console HQ' });
    assert.equal(own.status, 409);
    assert.equal(own.body.error.code, 'CANNOT_DELETE_OWNER');
  });
});

describe('changing your own password', () => {
  const EMAIL = 'changer@example.test';
  const OLD = 'the-old-password-1';
  const NEW = 'a-brand-new-password-2';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const change = (token, body) => api('POST', '/api/auth/change-password', { token, body });
  let oldSession;

  before(async () => {
    oldSession = (await signupAccount({ name: 'Changer Cafe', email: EMAIL, password: OLD })).body.data.token;
  });

  it('needs a signed-in session', async () => {
    assert.equal((await api('POST', '/api/auth/change-password', { body: { current_password: OLD, new_password: NEW } })).status, 401);
  });

  it('refuses a wrong current password without signing the person out', async () => {
    const res = await change(oldSession, { current_password: 'not-my-password', new_password: NEW });
    assert.equal(res.status, 400, 'a 400, not a 401, so the admin does not log itself out');
    assert.equal(res.body.error.code, 'WRONG_PASSWORD');
    assert.equal((await api('GET', '/api/auth/me', { token: oldSession })).status, 200);
  });

  it('refuses a short or unchanged new password', async () => {
    const short = await change(oldSession, { current_password: OLD, new_password: 'short' });
    assert.equal(short.status, 400);
    assert.equal(short.body.error.code, 'VALIDATION_ERROR');
    const same = await change(oldSession, { current_password: OLD, new_password: OLD });
    assert.equal(same.status, 400);
    assert.equal(same.body.error.code, 'SAME_PASSWORD');
    assert.equal((await change(oldSession, { new_password: NEW })).status, 400, 'the current password is required');
  });

  it('changes it, hands back a working session, and signs out the older ones', async () => {
    await wait(1100); // token times are whole seconds: make sure the old session is clearly older than the change
    const res = await change(oldSession, { current_password: OLD, new_password: NEW });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.token);
    assert.equal(res.body.data.vendor.email, EMAIL);
    assert.equal(res.body.data.vendor.password_hash, undefined, 'the hash never leaves the server');

    assert.equal((await api('GET', '/api/auth/me', { token: res.body.data.token })).status, 200, 'the fresh session works at once');
    assert.equal((await api('GET', '/api/auth/me', { token: oldSession })).status, 401, 'the old session is signed out');
    assert.equal((await api('POST', '/api/auth/login', { body: { email: EMAIL, password: OLD } })).status, 401);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: EMAIL, password: NEW } })).status, 200);
  });
});

describe('password reset by email', () => {
  const EMAIL = 'forgetful@example.test';
  const OLD = 'the-old-password-1';
  const NEW = 'a-brand-new-password-2';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // The token rides after '#', which browsers do not send to the web host.
  const tokenFrom = (mail) => new URLSearchParams(new URL(mail.text.match(/https?:\/\/\S+/)[0]).hash.slice(1)).get('token');
  let oldSession;
  let vendorId;

  before(async () => {
    const su = await signupAccount({ name: 'Forgetful Cafe', email: EMAIL, password: OLD });
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
    assert.ok(mail.text.includes(`${config.adminAppUrl}/reset-password#token=`));
    assert.ok(mail.html.includes('/reset-password#token='));
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
    const other = await signupAccount({ name: 'Other Place', email: 'other.place@example.test', password: 'a-long-enough-password' });
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
    assert.deepEqual(d.sales.by_method.map((m) => m.method), ['cash', 'razorpay', 'phonepe']);
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
    const other = await signupAccount({ name: 'Quiet Place', email: 'quiet.place@example.test', password: 'a-long-enough-password' });
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
    assert.match(paidRow, /^\d+,\d{4}-\d{2}-\d{2} \d{2}:\d{2},\d{4}-\d{2}-\d{2} \d{2}:\d{2},T-01,\w+,paid,(cash|razorpay|phonepe),/);
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
    const su = await signupAccount({ name: 'Demo Helper Cafe', email: OWNER, password: 'a-long-enough-password' });
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
    assert.ok(rows.every((o) => o.status === 'completed' && o.payment_status === 'paid' && o.payment_method === 'cash' && o.pay_pref === 'counter'));
    assert.ok(rows.every((o) => o.accepted_at && o.paid_at && o.completed_at && new Date(o.created_at) < new Date(o.accepted_at) && new Date(o.accepted_at) < new Date(o.paid_at) && new Date(o.paid_at) < new Date(o.completed_at)));
    assert.ok(rows.every((o) => new Date(o.completed_at) < new Date()), 'nothing is "in the future"');
    assert.equal((await orderRows()).length, realBefore + 4, 'real orders untouched');

    const items = (await db.query(`SELECT count(*)::int AS n, sum(line_total_paise)::int AS paise FROM order_items WHERE order_id = ANY($1::bigint[])`, [rows.map((o) => o.id)])).rows[0];
    assert.ok(items.n >= 4);
    assert.equal(items.paise, rows.reduce((n, o) => n + o.subtotal_paise, 0), 'line items add up to each order subtotal');
    assert.ok(rows.every((o) => o.total_paise === o.subtotal_paise + o.tax_paise));
    const payments = (await db.query(`SELECT count(*)::int AS n, sum(amount_paise)::int AS paise FROM payments WHERE order_id = ANY($1::bigint[]) AND provider = 'cash' AND status = 'paid'`, [rows.map((o) => o.id)])).rows[0];
    assert.deepEqual([payments.n, payments.paise], [4, rows.reduce((n, o) => n + o.total_paise, 0)]);

    const dash = (await api('GET', '/api/admin/dashboard/overview', { token })).body.data;
    const realPaid = (await orderRows()).filter((o) => o.payment_status === 'paid' && !o.idempotency_key?.startsWith('demo-history-')).reduce((n, o) => n + o.total_paise, 0);
    assert.equal(Math.round(dash.weekly_revenue.reduce((n, d) => n + d.revenue, 0) * 100), Math.round(r.revenue * 100) + realPaid, 'the 7-day chart counts the sample payments');
    assert.equal(dash.payment_methods.find((m) => m.method === 'cash').percent, 100);
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
    const empty = await signupAccount({ name: 'Empty Place', email: 'empty.place@example.test', password: 'a-long-enough-password' });
    await assert.rejects(generateHistory(db, { vendorId: empty.body.data.vendor.id, days: 2, orders: 4 }), /needs a menu and at least one table/);
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
    token = (await signupAccount({ name: 'QR Cafe', email: 'qr.cafe@example.test', password: 'a-long-enough-password' })).body.data.token;
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
    token = (await signupAccount({ name: 'Diet Cafe', email: 'diet.cafe@example.test', password: 'a-long-enough-password' })).body.data.token;
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
    token = (await signupAccount({ name: 'Ready Cafe', email: 'ready.cafe@example.test', password: 'a-long-enough-password' })).body.data.token;
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
    const other = (await signupAccount({ name: 'Other Cafe', email: 'other.ready@example.test', password: 'a-long-enough-password' })).body.data.token;
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
    token = (await signupAccount({ name: 'Code Cafe', email: 'code.cafe@example.test', password: 'a-long-enough-password' })).body.data.token;
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
    const other = (await signupAccount({ name: 'Other Code Cafe', email: 'other.code@example.test', password: 'a-long-enough-password' })).body.data.token;
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
    token = (await signupAccount({ name: 'Call Cafe', email: 'call.cafe@example.test', password: 'a-long-enough-password' })).body.data.token;
    const t = (await api('POST', '/api/admin/tables', { token, body: { number: 'W1', capacity: 2 } })).body.data;
    tableId = t.id;
    qr = t.qr_url.split('/').pop();
  });

  it('has nothing open to begin with', async () => {
    assert.deepEqual((await open()).body.data, []);
    assert.deepEqual((await api('GET', `/api/public/t/${qr}/requests`)).body.data, { waiter: false, bill: false, waiter_since: null, bill_since: null });
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
    const state = (await api('GET', `/api/public/t/${qr}/requests`)).body.data;
    assert.equal(state.waiter, true);
    assert.equal(state.bill, true);
    assert.match(state.waiter_since, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(w.body.data.waiter_since, state.waiter_since, 'the asker is told which request is theirs');
  });

  it('does not pile up when the diner taps again', async () => {
    const again = await ask('waiter');
    assert.equal(again.status, 200);
    assert.equal(again.body.data.already_asked, true);
    assert.equal((await open()).body.data.length, 2);
  });

  it('tells a second diner at the same table which request is already open, so each phone can tell its own', async () => {
    const before = (await api('GET', `/api/public/t/${qr}/requests`)).body.data;
    const newcomer = await ask('waiter');
    assert.equal(newcomer.body.data.already_asked, true);
    assert.equal(newcomer.body.data.waiter_since, before.waiter_since, 'same request, same timestamp: nothing new is created');
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
    const other = (await signupAccount({ name: 'Other Call Cafe', email: 'other.call@example.test', password: 'a-long-enough-password' })).body.data.token;
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
    token = (await signupAccount({ name: 'Bill Cafe', email: 'bill.cafe@example.test', password: 'a-long-enough-password' })).body.data.token;
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

  it('settles only in cash, and not at all when the product offers no cash', async () => {
    await order();
    assert.equal((await settle('bitcoin')).status, 400);
    assert.equal((await settle('upi')).status, 400, 'UPI no longer exists');
    config.paymentMethods = new Set(['razorpay']);
    try {
      const cash = await settle('cash');
      assert.equal(cash.status, 409);
      assert.equal(cash.body.error.code, 'METHOD_NOT_AVAILABLE');
    } finally {
      config.paymentMethods = new Set(['cash', 'razorpay', 'phonepe']);
    }
    assert.equal((await settle('cash')).status, 200);
  });

  it("does not let another restaurant see or settle this table's bill", async () => {
    await order();
    const other = (await signupAccount({ name: 'Other Bill Cafe', email: 'other.bill@example.test', password: 'a-long-enough-password' })).body.data.token;
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
    token = (await signupAccount({ name: 'Refund Cafe', email: 'refund.cafe@example.test', password: 'a-long-enough-password' })).body.data.token;
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
    const other = (await signupAccount({ name: 'Other Refund Cafe', email: 'other.refund@example.test', password: 'a-long-enough-password' })).body.data.token;
    assert.equal((await api('POST', `/api/admin/orders/${mine.id}/refund`, { token: other })).status, 404);
  });
});

describe('restaurant logo', () => {
  let token;
  let qr;
  let otherToken;
  const put = (raw, type = 'image/png', tok = token) => api('PUT', '/api/admin/vendor/logo', { token: tok, raw, headers: { 'Content-Type': type } });

  before(async () => {
    const su = await signupAccount({ name: 'Logo Cafe', email: 'logo.cafe@example.test', password: 'a-long-enough-password' });
    token = su.body.data.token;
    assert.equal(su.body.data.vendor.logo_url, null, 'no logo to begin with');
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'L1', capacity: 2 } })).body.data.qr_url.split('/').pop();
    otherToken = (await signupAccount({ name: 'No Logo Cafe', email: 'no.logo@example.test', password: 'a-long-enough-password' })).body.data.token;
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
    assert.deepEqual(me.body.data.theme, { primary: '#2f6f62', accent: '#e8872a', style: 'classic' });
    const patched = await api('PATCH', '/api/admin/vendor', { token: s.token, body: { theme_primary: '#B91C1C' } });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.data.theme, { primary: '#b91c1c', accent: '#e8872a', style: 'classic' }, 'normalised to lower case; accent and design untouched');
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
    assert.deepEqual(menu.body.data.vendor.theme, { primary: '#b91c1c', accent: '#e8872a', style: 'classic' });
    const order = await api('GET', `/api/public/orders/${s.secondOrderToken}`);
    assert.deepEqual(order.body.data.vendor.theme, { primary: '#b91c1c', accent: '#e8872a', style: 'classic' });
  });

  it("does not leak one restaurant's colours into another's", async () => {
    const other = await api('GET', '/api/auth/me', { token: s.otherToken });
    assert.equal(other.body.data.theme.primary, '#2f6f62');
  });

  it('lets the vendor pick one of the five designs, and serves it to the diner', async () => {
    const { STYLE_IDS } = await import('../../shared/styles.js');
    assert.deepEqual(STYLE_IDS, ['classic', 'bistro', 'gallery', 'minimal', 'night'], 'the five designs, in the order the admin shows them');
    for (const style of STYLE_IDS) {
      const r = await api('PATCH', '/api/admin/vendor', { token: s.token, body: { theme_style: style } });
      assert.equal(r.status, 200, style);
      assert.equal(r.body.data.theme.style, style);
      assert.equal(r.body.data.theme.primary, '#b91c1c', 'choosing a design keeps the colours');
    }
    const menu = await api('GET', `/api/public/t/${s.qrToken}`);
    assert.equal(menu.body.data.vendor.theme.style, 'night', 'the last one chosen');
    const order = await api('GET', `/api/public/orders/${s.secondOrderToken}`);
    assert.equal(order.body.data.vendor.theme.style, 'night');
    // Another restaurant is not affected, and an unknown design is refused.
    assert.equal((await api('GET', '/api/auth/me', { token: s.otherToken })).body.data.theme.style, 'classic');
    for (const bad of ['Classic', 'dark', '', 'neon']) {
      assert.equal((await api('PATCH', '/api/admin/vendor', { token: s.token, body: { theme_style: bad } })).status, 400, `"${bad}" should be refused`);
    }
    await api('PATCH', '/api/admin/vendor', { token: s.token, body: { theme_style: 'classic' } });
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

describe('online payments (PhonePe)', () => {
  const CLIENT_ID = 'TESTMERCHANT_2501';
  const SECRET = 'phonepe-client-secret-value';
  let token;
  let qr;
  let itemId;
  let mock;
  let savedBase;
  const orders = new Map(); // merchantOrderId -> { amount, state, txn }
  let txnSeq = 9000;
  const calls = [];
  const put = (body) => api('PUT', '/api/admin/payment-settings', { token, body });
  const place = async (pay_pref) => {
    const r = await api('POST', `/api/public/t/${qr}/orders`, { body: { pay_pref, items: [{ item_id: itemId, quantity: 2, option_ids: [] }] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };
  const start = (order) => api('POST', `/api/public/orders/${order.token}/pay/phonepe`);
  const verify = (order) => api('POST', `/api/public/orders/${order.token}/pay/phonepe/verify`);
  const lastAttempt = async (order) =>
    (await db.query(`SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_token = $1 AND p.provider = 'phonepe' ORDER BY p.id DESC LIMIT 1`, [order.token])).rows[0];

  before(async () => {
    // A fake PhonePe: it hands out tokens for the right keys, remembers the orders it was asked to open and lets the test decide who paid.
    mock = await new Promise((resolve) => {
      const server = http
        .createServer((req, res) => {
          let data = '';
          req.on('data', (c) => (data += c));
          req.on('end', () => {
            const path = req.url.split('?')[0];
            const body = data && req.headers['content-type']?.includes('json') ? JSON.parse(data) : data;
            calls.push({ method: req.method, path, headers: req.headers, body });
            res.setHeader('Content-Type', 'application/json');
            const send = (code, json) => {
              res.statusCode = code;
              res.end(JSON.stringify(json));
            };
            if (path === '/v1/oauth/token') {
              const form = new URLSearchParams(data);
              if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== SECRET || form.get('client_version') !== '1' || form.get('grant_type') !== 'client_credentials') {
                return send(400, { code: 'BAD_REQUEST', message: 'Invalid client credentials' });
              }
              return send(200, { access_token: 'tok_123', token_type: 'O-Bearer', expires_at: Math.floor(Date.now() / 1000) + 3600 });
            }
            if (req.headers.authorization !== 'O-Bearer tok_123') return send(401, { code: 'AUTHORIZATION_FAILED', message: 'bad token' });
            if (req.method === 'POST' && path === '/checkout/v2/pay') {
              orders.set(body.merchantOrderId, { amount: body.amount, state: 'PENDING', txn: `OM_TXN_${(txnSeq += 1)}` });
              return send(200, { orderId: `OMO_${body.merchantOrderId}`, state: 'PENDING', expireAt: Date.now() + 1_800_000, redirectUrl: `https://mercury-uat.phonepe.example/pay/${body.merchantOrderId}` });
            }
            const m = path.match(/^\/checkout\/v2\/order\/([^/]+)\/status$/);
            if (req.method === 'GET' && m) {
              const found = orders.get(decodeURIComponent(m[1]));
              if (!found) return send(404, { code: 'INVALID_MERCHANT_ORDER_ID', message: 'No entry found for given merchant order id' });
              return send(200, {
                orderId: `OMO_${decodeURIComponent(m[1])}`,
                state: found.state,
                amount: found.paidAmount ?? found.amount,
                paymentDetails: found.state === 'COMPLETED' ? [{ transactionId: found.txn, paymentMode: 'UPI_QR', state: 'COMPLETED', amount: found.paidAmount ?? found.amount }] : [],
              });
            }
            if (req.method === 'POST' && path === '/payments/v2/refund') return send(200, { refundId: 'OMR_5001', amount: body.amount, state: 'PENDING' });
            return send(404, { code: 'NOT_FOUND', message: 'no such endpoint' });
          });
        })
        .listen(0, '127.0.0.1', () => resolve(server));
    });
    savedBase = config.phonepeApiBase;
    config.phonepeApiBase = `http://127.0.0.1:${mock.address().port}`;

    token = (await signupAccount({ name: 'PhonePe Cafe', email: 'phonepe.cafe@example.test', password: 'a-long-enough-password' })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Masala Chai', price: 40 } })).body.data.id;
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'P1', capacity: 2 } })).body.data.qr_url.split('/').pop();
  });

  after(async () => {
    config.phonepeApiBase = savedBase;
    await new Promise((r) => mock.close(r));
  });

  it('tells the diner to pay another way while the restaurant has no PhonePe keys', async () => {
    const order = await place();
    const r = await start(order);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'GATEWAY_NOT_CONFIGURED');
    assert.equal((await api('POST', `/api/public/orders/${order.token}/pay/bitcoin`)).status, 404, 'only known gateways have this route');
  });

  it('validates and stores the keys without ever returning the secret', async () => {
    assert.equal((await put({ phonepe_client_id: 'no spaces allowed', phonepe_client_secret: SECRET })).status, 400);
    assert.equal((await put({ phonepe_enabled: true })).status, 400, 'no keys yet');

    const wrong = await put({ phonepe_enabled: true, phonepe_client_id: CLIENT_ID, phonepe_client_version: '1', phonepe_client_secret: 'wrong-secret-value' });
    assert.equal(wrong.status, 200);
    const failing = await api('POST', '/api/admin/payment-settings/test', { token, body: { provider: 'phonepe' } });
    assert.equal(failing.status, 502);
    assert.equal(failing.body.error.code, 'PHONEPE_BAD_KEYS');

    const saved = await put({ phonepe_client_secret: SECRET });
    assert.equal(saved.body.data.phonepe_configured, true);
    assert.equal('phonepe_env' in saved.body.data, false, 'there is no sandbox choice');
    assert.equal(saved.body.data.phonepe_client_id, CLIENT_ID);
    assert.ok(!JSON.stringify(saved.body).includes(SECRET));
    const stored = await db.query(`SELECT phonepe_secret_enc FROM vendor_payment_settings WHERE phonepe_client_id = $1`, [CLIENT_ID]);
    assert.ok(stored.rows.every((row) => !String(row.phonepe_secret_enc).includes(SECRET)), 'secret is encrypted at rest');
    const ok = await api('POST', '/api/admin/payment-settings/test', { token, body: { provider: 'phonepe' } });
    assert.equal(ok.body.data.ok, true);
    assert.equal(ok.body.data.mode, 'live');

    const menu = await api('GET', `/api/public/t/${qr}`);
    assert.equal(menu.body.data.payment_options.phonepe, true);
    assert.equal(menu.body.data.payment_options.razorpay, false);
  });

  it('talks only to PhonePe\'s live servers', async () => {
    const { pingPhonepe } = await import('../src/lib/phonepe.js');
    const realFetch = globalThis.fetch;
    const fake = config.phonepeApiBase;
    const asked = [];
    config.phonepeApiBase = '';
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
    };
    try {
      await pingPhonepe({ clientId: 'LIVEMERCHANT_1', clientVersion: '1', clientSecret: 'a-live-client-secret' });
    } finally {
      globalThis.fetch = realFetch;
      config.phonepeApiBase = fake;
    }
    assert.deepEqual(asked, ['https://api.phonepe.com/apis/identity-manager/v1/oauth/token']);
  });

  it('lets a restaurant use one online gateway at a time', async () => {
    const both = await put({ razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' });
    assert.equal(both.status, 400);
    assert.match(both.body.error.message, /one online payment gateway/);
    const swap = await put({ phonepe_enabled: false, razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' });
    assert.equal(swap.status, 200);
    assert.equal((await api('GET', `/api/public/t/${qr}`)).body.data.payment_options.phonepe, false);
    const back = await put({ razorpay_enabled: false, phonepe_enabled: true });
    assert.equal(back.status, 200);
    assert.equal(back.body.data.phonepe_secret_set, true, 'the saved secret is kept');
  });

  it('opens a PhonePe payment and marks the order paid only when PhonePe says COMPLETED', async () => {
    const order = await place('online');
    const a = await start(order);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.data.client.type, 'redirect');
    assert.match(a.body.data.client.url, /^https:\/\/mercury-uat\.phonepe\.example\/pay\/mz_/);
    assert.equal(a.body.data.amount, 80);
    const pay = calls.filter((c) => c.path === '/checkout/v2/pay').at(-1);
    assert.match(pay.body.merchantOrderId, /^mz_[a-f0-9]{24}$/, 'random: it does not show the order\'s number');
    assert.ok(pay.body.merchantOrderId.length <= 63);
    assert.equal(pay.body.amount, 8000, 'amounts go to PhonePe in paise');
    assert.equal(pay.body.paymentFlow.type, 'PG_CHECKOUT');
    assert.match(pay.body.paymentFlow.merchantUrls.redirectUrl, new RegExp(`/o/${order.token}$`));
    const attempt = await lastAttempt(order);
    assert.equal(attempt.status, 'created');

    // Coming back from the PhonePe page, or a made-up claim, does not make the order paid: only PhonePe can.
    const early = await verify(order);
    assert.equal(early.status, 200);
    assert.equal(early.body.data.payment_status, 'unpaid');
    orders.get(attempt.provider_order_id).state = 'FAILED';
    assert.equal((await verify(order)).body.data.payment_status, 'unpaid', 'a failed state does not pay the order');

    orders.get(attempt.provider_order_id).state = 'COMPLETED';
    const paid = await verify(order);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.data.payment_status, 'paid');
    assert.equal(paid.body.data.payment_method, 'phonepe');
    assert.equal(paid.body.data.status, 'accepted', 'paying online accepts the order');
    const row = await lastAttempt(order);
    assert.equal(row.status, 'paid');
    assert.equal(row.provider_payment_id, orders.get(attempt.provider_order_id).txn);

    assert.equal((await verify(order)).status, 200, 'verifying again is harmless');
    assert.equal((await start(order)).status, 409, 'an already paid order cannot be paid again');
  });

  it('does not mark an order paid when the amount PhonePe took is different', async () => {
    const order = await place('online');
    assert.equal((await start(order)).status, 200);
    const attempt = await lastAttempt(order);
    Object.assign(orders.get(attempt.provider_order_id), { state: 'COMPLETED', paidAmount: 100 });
    const r = await verify(order);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'PAYMENT_AMOUNT_MISMATCH');
    assert.equal((await api('GET', `/api/public/orders/${order.token}`)).body.data.payment_status, 'unpaid');
  });

  it('finds a payment made on an earlier attempt instead of charging again', async () => {
    const order = await place('online');
    assert.equal((await start(order)).status, 200);
    const first = await lastAttempt(order);
    assert.equal((await start(order)).status, 200, 'a second tap opens a second attempt');
    const second = await lastAttempt(order);
    assert.notEqual(second.provider_order_id, first.provider_order_id);
    orders.get(first.provider_order_id).state = 'COMPLETED'; // the diner paid on the first page after all
    const again = await start(order);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_PAID');
    assert.equal((await api('GET', `/api/public/orders/${order.token}`)).body.data.payment_status, 'paid');
  });

  it('refunds a PhonePe payment from the admin and records it', async () => {
    const order = await place('online');
    await start(order);
    const attempt = await lastAttempt(order);
    orders.get(attempt.provider_order_id).state = 'COMPLETED';
    await verify(order);
    const id = (await db.query(`SELECT id FROM orders WHERE public_token = $1`, [order.token])).rows[0].id;

    const refunded = await api('POST', `/api/admin/orders/${id}/refund`, { token });
    assert.equal(refunded.status, 200, JSON.stringify(refunded.body));
    assert.equal(refunded.body.data.payment_status, 'refunded');
    assert.equal(refunded.body.data.status, 'cancelled');
    const call = calls.filter((c) => c.path === '/payments/v2/refund').at(-1);
    assert.equal(call.body.originalMerchantOrderId, attempt.provider_order_id);
    assert.equal(call.body.amount, 8000);
    assert.match(call.body.merchantRefundId, /^mzr_\d+_/);
    const row = await lastAttempt(order);
    assert.equal(row.status, 'refunded');
    assert.equal(row.refund_id, 'OMR_5001');
    assert.equal((await api('POST', `/api/admin/orders/${id}/refund`, { token })).body.error.code, 'ALREADY_REFUNDED');
  });
});

describe('payment webhooks (the gateway tells us a payment arrived)', () => {
  const PASSWORD = 'a-long-enough-password';
  const RZ_SECRET = 'whsec-razorpay-1234';
  const PP_USER = 'hook-user';
  const PP_PASS = 'hook-password-99';
  const CLIENT_ID = 'TESTMERCHANT_2501';
  const CLIENT_SECRET = 'phonepe-client-secret-value';
  const ppOrders = new Map(); // fake PhonePe: merchantOrderId -> { amount, state, paidAmount }
  let phonepe;
  let savedBase;
  let rz; // the Razorpay restaurant
  let pp; // the PhonePe restaurant
  const none = () => {};

  const setup = async (name, email) => {
    const token = (await signupAccount({ name, email, password: PASSWORD })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    const item = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Masala Chai', price: 40 } })).body.data;
    const qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'W1', capacity: 2 } })).body.data.qr_url.split('/').pop();
    return { token, itemId: item.id, qr, put: (body) => api('PUT', '/api/admin/payment-settings', { token, body }) };
  };
  const place = async (r) => {
    const res = await api('POST', `/api/public/t/${r.qr}/orders`, { body: { pay_pref: 'online', items: [{ item_id: r.itemId, quantity: 2, option_ids: [] }] } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };
  const view = async (order) => (await api('GET', `/api/public/orders/${order.token}`)).body.data;
  const hookKey = async (r) => (await api('GET', '/api/admin/payment-settings', { token: r.token })).body.data.webhook_url_razorpay.split('/').pop();

  // Razorpay signs the raw body with the webhook secret.
  const rzHook = (key, event, { secret = RZ_SECRET, signature } = {}) => {
    const raw = JSON.stringify(event);
    const sig = signature ?? createHmac('sha256', secret).update(raw).digest('hex');
    return api('POST', `/api/webhooks/razorpay/${key}`, { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig } });
  };
  const captured = (orderId, amountPaise, paymentId = 'pay_HOOK0001') => ({
    event: 'order.paid',
    payload: { order: { entity: { id: orderId, status: 'paid' } }, payment: { entity: { id: paymentId, order_id: orderId, amount: amountPaise, status: 'captured' } } },
  });
  // PhonePe sends SHA256(username:password) in the Authorization header.
  const ppAuth = createHash('sha256').update(`${PP_USER}:${PP_PASS}`).digest('hex');
  const ppHook = (key, merchantOrderId, event = 'checkout.order.completed', authorization = ppAuth) =>
    api('POST', `/api/webhooks/phonepe/${key}`, { body: { event, payload: { merchantOrderId, state: 'COMPLETED' } }, headers: { Authorization: authorization } });
  const attemptOf = async (order, provider) =>
    (await db.query(`SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_token = $1 AND p.provider = $2 ORDER BY p.id DESC LIMIT 1`, [order.token, provider])).rows[0];

  before(async () => {
    phonepe = await new Promise((resolve) => {
      const server = http
        .createServer((req, res) => {
          let data = '';
          req.on('data', (c) => (data += c));
          req.on('end', () => {
            const path = req.url.split('?')[0];
            res.setHeader('Content-Type', 'application/json');
            const send = (code, json) => {
              res.statusCode = code;
              res.end(JSON.stringify(json));
            };
            if (path === '/v1/oauth/token') return send(200, { access_token: 'tok_hook', token_type: 'O-Bearer', expires_at: Math.floor(Date.now() / 1000) + 3600 });
            if (req.method === 'POST' && path === '/checkout/v2/pay') {
              const body = JSON.parse(data);
              ppOrders.set(body.merchantOrderId, { amount: body.amount, state: 'PENDING' });
              return send(200, { orderId: `OMO_${body.merchantOrderId}`, state: 'PENDING', redirectUrl: `https://mercury-uat.phonepe.example/pay/${body.merchantOrderId}` });
            }
            const m = path.match(/^\/checkout\/v2\/order\/([^/]+)\/status$/);
            if (req.method === 'GET' && m) {
              const found = ppOrders.get(decodeURIComponent(m[1]));
              if (!found) return send(404, { code: 'INVALID_MERCHANT_ORDER_ID' });
              const amount = found.paidAmount ?? found.amount;
              return send(200, { orderId: `OMO_${m[1]}`, state: found.state, amount, paymentDetails: found.state === 'COMPLETED' ? [{ transactionId: `TXN_${m[1]}`, state: 'COMPLETED', amount }] : [] });
            }
            return send(404, { code: 'NOT_FOUND' });
          });
        })
        .listen(0, '127.0.0.1', () => resolve(server));
    });
    savedBase = config.phonepeApiBase;
    config.phonepeApiBase = `http://127.0.0.1:${phonepe.address().port}`;

    rz = await setup('Hook Razorpay Cafe', 'hook.razorpay@example.test');
    assert.equal((await rz.put({ razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' })).status, 200);
    pp = await setup('Hook PhonePe Cafe', 'hook.phonepe@example.test');
    assert.equal((await pp.put({ phonepe_enabled: true, phonepe_client_id: CLIENT_ID, phonepe_client_version: '1', phonepe_client_secret: CLIENT_SECRET })).status, 200);
  });

  after(async () => {
    config.phonepeApiBase = savedBase;
    await new Promise((r) => phonepe.close(r));
  });

  it("gives each restaurant its own private webhook address, and keeps the secrets write-only", async () => {
    const a = (await api('GET', '/api/admin/payment-settings', { token: rz.token })).body.data;
    const b = (await api('GET', '/api/admin/payment-settings', { token: pp.token })).body.data;
    assert.match(a.webhook_url_razorpay, /\/api\/webhooks\/razorpay\/[a-f0-9]{32}$/);
    assert.match(a.webhook_url_phonepe, /\/api\/webhooks\/phonepe\/[a-f0-9]{32}$/);
    assert.notEqual(a.webhook_url_razorpay.split('/').pop(), b.webhook_url_razorpay.split('/').pop(), 'unguessable and different for every restaurant');
    assert.equal(a.webhook_url_razorpay.split('/').pop(), a.webhook_url_phonepe.split('/').pop(), 'one key per restaurant');
    assert.deepEqual([a.razorpay_webhook_set, a.phonepe_webhook_set], [false, false]);

    assert.equal((await rz.put({ razorpay_webhook_secret: 'short' })).status, 400);
    const saved = await rz.put({ razorpay_webhook_secret: RZ_SECRET });
    assert.equal(saved.body.data.razorpay_webhook_set, true);
    assert.ok(!JSON.stringify(saved.body).includes(RZ_SECRET), 'the secret is never returned');

    assert.equal((await pp.put({ phonepe_webhook_username: PP_USER })).status, 400, 'both the username and the password');
    assert.equal((await pp.put({ phonepe_webhook_password: PP_PASS })).status, 400);
    const ppSaved = await pp.put({ phonepe_webhook_username: PP_USER, phonepe_webhook_password: PP_PASS });
    assert.equal(ppSaved.body.data.phonepe_webhook_set, true);
    assert.ok(!JSON.stringify(ppSaved.body).includes(PP_PASS));
    const stored = await db.query(`SELECT razorpay_webhook_secret_enc, phonepe_webhook_auth_enc FROM vendor_payment_settings WHERE razorpay_webhook_secret_enc IS NOT NULL OR phonepe_webhook_auth_enc IS NOT NULL`);
    assert.ok(stored.rows.every((row) => !String(row.razorpay_webhook_secret_enc ?? '').includes(RZ_SECRET) && !String(row.phonepe_webhook_auth_enc ?? '').includes(ppAuth)), 'encrypted at rest');
  });

  it('refuses a webhook it cannot place or trust', async () => {
    assert.equal((await rzHook('f'.repeat(32), captured('order_X', 100))).status, 404, 'unknown address');
    assert.equal((await rzHook('not-a-key', captured('order_X', 100))).status, 404);
    const key = await hookKey(rz);
    const forged = await rzHook(key, captured('order_X', 100), { secret: 'some-other-secret' });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error.code, 'WEBHOOK_SIGNATURE_INVALID');
    assert.equal((await rzHook(key, captured('order_X', 100), { signature: '' })).status, 400, 'no signature at all');
    const ppKey = await hookKey(pp);
    const wrong = await ppHook(ppKey, 'mz_1_x', 'checkout.order.completed', 'f'.repeat(64));
    assert.equal(wrong.status, 401);
    assert.equal((await ppHook(ppKey, 'mz_1_x', 'checkout.order.completed', '')).status, 401);
    // A restaurant that has not set a webhook secret up yet.
    const fresh = await setup('Hook Fresh Cafe', 'hook.fresh@example.test');
    const freshKey = await hookKey(fresh);
    assert.equal((await rzHook(freshKey, captured('order_X', 100))).body.error.code, 'WEBHOOK_NOT_SET_UP');
    assert.equal((await ppHook(freshKey, 'mz_1_x')).body.error.code, 'WEBHOOK_NOT_SET_UP');
  });

  it('marks a Razorpay order paid from the webhook, with the diner nowhere near the page', async () => {
    const order = await place(rz);
    assert.equal((await api('POST', `/api/public/orders/${order.token}/razorpay`)).status, 200); // the diner opened the Razorpay checkout
    const key = await hookKey(rz);
    const amount = Math.round(order.total * 100);

    const wrongAmount = await rzHook(key, captured('order_MOCK123456', amount - 100));
    assert.equal(wrongAmount.status, 200);
    assert.equal(wrongAmount.body.data.mismatch, true);
    assert.equal((await view(order)).payment_status, 'unpaid', 'a different amount is never accepted');
    assert.equal((await rzHook(key, { event: 'payment.failed', payload: { payment: { entity: { id: 'pay_F', order_id: 'order_MOCK123456', amount, status: 'failed' } } } })).body.data.ignored, true);
    assert.equal((await view(order)).payment_status, 'unpaid');

    const paid = await rzHook(key, captured('order_MOCK123456', amount));
    assert.equal(paid.status, 200);
    assert.equal(paid.body.data.paid, true);
    const after = await view(order);
    assert.equal(after.payment_status, 'paid');
    assert.equal(after.payment_method, 'razorpay');
    assert.equal(after.status, 'accepted', 'paying online accepts the order');
    const attempt = await attemptOf(order, 'razorpay');
    assert.deepEqual([attempt.status, attempt.provider_payment_id], ['paid', 'pay_HOOK0001']);

    // Razorpay may send the same event again, and the diner's own page may report it too: nothing changes twice.
    const again = await rzHook(key, captured('order_MOCK123456', amount));
    assert.equal(again.status, 200);
    assert.equal(again.body.data.already, true);
    const sig = createHmac('sha256', 'secret-value-123').update('order_MOCK123456|pay_HOOK0001').digest('hex');
    assert.equal((await api('POST', `/api/public/orders/${order.token}/razorpay/verify`, { body: { razorpay_order_id: 'order_MOCK123456', razorpay_payment_id: 'pay_HOOK0001', razorpay_signature: sig } })).body.data.payment_status, 'paid');
  });

  it("does not let one restaurant's webhook pay another restaurant's order", async () => {
    const order = await place(rz);
    await api('POST', `/api/public/orders/${order.token}/razorpay`);
    // The other restaurant has its own (valid) webhook, but this order is not its own.
    const otherKey = await hookKey(pp);
    assert.equal((await api('PUT', '/api/admin/payment-settings', { token: pp.token, body: { razorpay_webhook_secret: RZ_SECRET } })).status, 200);
    const res = await rzHook(otherKey, captured('order_MOCK123456', Math.round(order.total * 100), 'pay_HOOK0002'));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.ignored, true);
    assert.equal((await view(order)).payment_status, 'unpaid');
  });

  it('marks a Razorpay scan-to-pay (UPI QR) order paid from qr_code.credited', async () => {
    const order = await place(rz);
    const qr = await api('POST', `/api/public/orders/${order.token}/razorpay-qr`);
    assert.equal(qr.status, 200);
    const key = await hookKey(rz);
    const amount = Math.round(order.total * 100);
    const res = await rzHook(key, { event: 'qr_code.credited', payload: { qr_code: { entity: { id: qr.body.data.qr_id } }, payment: { entity: { id: 'pay_HOOKQR1', amount, status: 'captured' } } } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.paid, true);
    assert.equal((await view(order)).payment_status, 'paid');
  });

  it('marks a PhonePe order paid, but only when PhonePe itself says so (the call is just a nudge)', async () => {
    const order = await place(pp);
    const start = await api('POST', `/api/public/orders/${order.token}/pay/phonepe`);
    assert.equal(start.status, 200);
    const attempt = await attemptOf(order, 'phonepe');
    const key = await hookKey(pp);

    // The webhook says "completed", but PhonePe's own answer is still PENDING: nothing changes.
    const early = await ppHook(key, attempt.provider_order_id);
    assert.equal(early.status, 200);
    assert.equal(early.body.data.state, 'pending');
    assert.equal((await view(order)).payment_status, 'unpaid');

    // A different amount than the order is never accepted.
    ppOrders.get(attempt.provider_order_id).state = 'COMPLETED';
    ppOrders.get(attempt.provider_order_id).paidAmount = attempt.amount_paise - 100;
    const wrong = await ppHook(key, attempt.provider_order_id);
    assert.equal(wrong.body.data.mismatch, true);
    assert.equal((await view(order)).payment_status, 'unpaid');

    delete ppOrders.get(attempt.provider_order_id).paidAmount;
    const paid = await ppHook(key, attempt.provider_order_id);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.data.paid, true);
    const after = await view(order);
    assert.deepEqual([after.payment_status, after.payment_method, after.status], ['paid', 'phonepe', 'accepted']);
    assert.equal((await ppHook(key, attempt.provider_order_id)).body.data.already, true, 'the same call twice changes nothing');
    assert.equal((await ppHook(key, 'mz_999999_unknown')).body.data.ignored, true, 'an order we never opened is ignored, not an error');
    assert.equal((await ppHook(key, attempt.provider_order_id, 'pg.refund.completed')).body.data.ignored, true, 'other events are ignored');
  });

  it('the safety net finds payments whose webhook never came', async () => {
    const order = await place(pp);
    await api('POST', `/api/public/orders/${order.token}/pay/phonepe`);
    const attempt = await attemptOf(order, 'phonepe');
    ppOrders.get(attempt.provider_order_id).state = 'COMPLETED'; // the money arrived; nobody told us

    // Too fresh: the diner's own page and the webhook get their chance first.
    assert.equal((await reconcileOnce(db, { log: { info: none, warn: none } })).paid, 0);
    assert.equal((await view(order)).payment_status, 'unpaid');

    await db.query(`UPDATE payments SET created_at = now() - interval '10 minutes' WHERE id = $1`, [attempt.id]);
    const run = await reconcileOnce(db, { log: { info: none, warn: none } });
    assert.ok(run.checked >= 1);
    assert.ok(run.paid >= 1);
    assert.deepEqual([(await view(order)).payment_status, (await view(order)).payment_method], ['paid', 'phonepe']);
    assert.equal((await reconcileOnce(db, { log: { info: none, warn: none } })).paid, 0, 'nothing left to find');
  });

  it('the safety net also finds a Razorpay QR payment and money paid for a cancelled order, and guesses nothing PhonePe has not got', async () => {
    const order = await place(rz);
    const qr = (await api('POST', `/api/public/orders/${order.token}/razorpay-qr`)).body.data;
    qrCodes.get(qr.qr_id).payments.push({ id: 'pay_RECON01', status: 'captured', amount: Math.round(order.total * 100) });

    const cancelled = await place(pp);
    await api('POST', `/api/public/orders/${cancelled.token}/pay/phonepe`);
    const cancelledAttempt = await attemptOf(cancelled, 'phonepe');
    ppOrders.get(cancelledAttempt.provider_order_id).state = 'COMPLETED';
    await db.query(`UPDATE orders SET status = 'cancelled' WHERE public_token = $1`, [cancelled.token]);

    const pending = await place(pp);
    await api('POST', `/api/public/orders/${pending.token}/pay/phonepe`); // PhonePe still says PENDING
    await db.query(`UPDATE payments SET created_at = now() - interval '10 minutes' WHERE order_id IN (SELECT id FROM orders WHERE public_token = ANY($1))`, [[order.token, cancelled.token, pending.token]]);

    await reconcileOnce(db, { log: { info: none, warn: none } });
    assert.equal((await view(order)).payment_status, 'paid');
    const gone = await view(cancelled);
    assert.deepEqual([gone.status, gone.payment_status], ['cancelled', 'paid'], 'money that arrived is recorded; the order stays cancelled');
    const flagged = (await api('GET', '/api/admin/orders/attention', { token: pp.token })).body.data;
    assert.ok(flagged.some((f) => f.kind === 'cancelled_paid' && f.order_number === gone.number), 'and the restaurant is told to give it back');
    assert.equal((await view(pending)).payment_status, 'unpaid', 'still pending at PhonePe: nothing is guessed');
  });

  it('takes only live Razorpay keys on the live server: with a test key nothing can mark an order paid', async () => {
    const r = await setup('Live Only Cafe', 'live.only@example.test');
    const testKeys = { razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' };
    // From before the rule: a saved test key with its webhook secret, an open checkout, and a QR that Razorpay's test mode says is paid.
    assert.equal((await r.put({ ...testKeys, razorpay_webhook_secret: RZ_SECRET })).status, 200);
    const order = await place(r);
    const amount = Math.round(order.total * 100);
    assert.equal((await api('POST', `/api/public/orders/${order.token}/razorpay`)).status, 200);
    const qr = (await api('POST', `/api/public/orders/${order.token}/razorpay-qr`)).body.data;
    qrCodes.get(qr.qr_id).payments.push({ id: 'pay_TESTQR01', status: 'captured', amount });
    await db.query(`UPDATE payments SET created_at = now() - interval '10 minutes' WHERE order_id IN (SELECT id FROM orders WHERE public_token = $1)`, [order.token]);
    const key = await hookKey(r);

    config.razorpayLiveOnly = true;
    try {
      const settings = (await api('GET', '/api/admin/payment-settings', { token: r.token })).body.data;
      assert.deepEqual([settings.razorpay_live_only, settings.razorpay_configured], [true, false]);
      assert.equal((await api('GET', `/api/public/t/${r.qr}`)).body.data.payment_options.razorpay, false);
      assert.equal((await api('POST', `/api/public/orders/${order.token}/razorpay`)).status, 409);
      assert.equal((await api('POST', `/api/public/orders/${order.token}/razorpay-qr`)).status, 409);

      const signature = createHmac('sha256', 'secret-value-123').update('order_MOCK123456|pay_TESTCHK1').digest('hex');
      const checkout = await api('POST', `/api/public/orders/${order.token}/razorpay/verify`, {
        body: { razorpay_order_id: 'order_MOCK123456', razorpay_payment_id: 'pay_TESTCHK1', razorpay_signature: signature },
      });
      assert.equal(checkout.status, 400);
      assert.equal((await rzHook(key, captured('order_MOCK123456', amount, 'pay_TESTHK01'))).body.data.ignored, true);
      await api('POST', `/api/public/orders/${order.token}/razorpay-qr/verify`);
      await reconcileOnce(db, { log: { info: none, warn: none } });
      assert.equal((await view(order)).payment_status, 'unpaid');

      const refused = await r.put(testKeys);
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error.details[0].field, 'razorpay_key_id');
      assert.match((await r.put({ razorpay_enabled: true })).body.error.message, /test key/);
      assert.equal((await api('POST', '/api/admin/payment-settings/test', { token: r.token })).body.error.code, 'RAZORPAY_TEST_KEY');

      const live = await r.put({ razorpay_enabled: true, razorpay_key_id: 'rzp_live_abcdef123456', razorpay_key_secret: 'live-secret-value' });
      assert.equal(live.status, 200);
      assert.equal(live.body.data.razorpay_configured, true);
      assert.equal((await api('GET', `/api/public/t/${r.qr}`)).body.data.payment_options.razorpay, true);
    } finally {
      config.razorpayLiveOnly = false;
    }
  });
});

describe("each restaurant's own order numbers", () => {
  const mk = async (name, email) => {
    const token = (await signupAccount({ name, email, password: 'a-long-enough-password' })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    const itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data.id;
    const table = (await api('POST', '/api/admin/tables', { token, body: { number: 'N1', capacity: 2 } })).body.data;
    return { token, itemId, qr: table.qr_url.split('/').pop() };
  };
  const order = async (r) => {
    const res = await api('POST', `/api/public/t/${r.qr}/orders`, { body: { items: [{ item_id: r.itemId, quantity: 1, option_ids: [] }] } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };
  const list = async (r, query = '') => (await api('GET', `/api/admin/orders?per_page=50${query}`, { token: r.token })).body.data;
  let a;
  let b;

  before(async () => {
    a = await mk('Numbers A', 'numbers.a@example.test');
    b = await mk('Numbers B', 'numbers.b@example.test');
  });

  it("starts every restaurant at #1 and counts its own orders, whatever the others do", async () => {
    const a1 = await order(a);
    const b1 = await order(b);
    const a2 = await order(a);
    const b2 = await order(b);
    const a3 = await order(a);
    assert.deepEqual([a1.number, a2.number, a3.number], [1, 2, 3]);
    assert.deepEqual([b1.number, b2.number], [1, 2]);

    const mine = await list(a);
    assert.deepEqual(mine.map((o) => o.number).sort(), [1, 2, 3]);
    assert.ok(mine.every((o) => Number.isInteger(o.id)), 'the internal id is still there for the admin URLs');
    const detail = (await api('GET', `/api/admin/orders/${mine[0].id}`, { token: a.token })).body.data;
    assert.equal(detail.number, mine[0].number);
    assert.equal((await api('GET', `/api/public/orders/${a2.token}`)).body.data.number, 2, 'the diner sees the same number');
  });

  it('finds an order by the number people see, and only in its own restaurant', async () => {
    const hit = await list(a, '&q=2');
    assert.deepEqual(hit.map((o) => o.number), [2]);
    const other = await list(b, '&q=3');
    assert.deepEqual(other, [], 'restaurant B has no order #3');
  });

  it('never hands out the number of a deleted order again', async () => {
    const latest = (await list(a))[0];
    assert.equal(latest.number, 3);
    assert.equal((await api('DELETE', `/api/admin/orders/${latest.id}`, { token: a.token })).status, 204);
    assert.equal((await order(a)).number, 4);
  });

  it('numbers the receipt, the table bill and the report with the restaurant number', async () => {
    const o = (await list(a)).find((x) => x.number === 2);
    await api('POST', `/api/admin/orders/${o.id}/cash-payment`, { token: a.token });
    const pdf = await api('GET', `/api/admin/orders/${o.id}/receipt.pdf`, { token: a.token });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-disposition'), /receipt-2\.pdf/);

    const tables = (await api('GET', '/api/admin/tables', { token: a.token })).body.data;
    const bill = (await api('GET', `/api/admin/tables/${tables[0].id}/bill`, { token: a.token })).body.data;
    assert.ok(bill.orders.every((x) => Number.isInteger(x.number)));
    assert.deepEqual(bill.orders.map((x) => x.number).sort(), [1, 4]);

    const dash = (await api('GET', '/api/admin/dashboard/overview', { token: a.token })).body.data;
    assert.ok(dash.latest_orders.every((x) => Number.isInteger(x.number)));
    // The restaurant's "today" can be a different calendar day than UTC's (India is ahead), so ask for a day either side.
    const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const csv = await api('GET', `/api/admin/reports/orders.csv?from=${from}&to=${to}`, { token: a.token });
    assert.equal(csv.status, 200);
    const lines = Buffer.from(csv.body).toString('utf8').split(/\r?\n/);
    assert.deepEqual(
      lines.slice(1).filter(Boolean).map((l) => l.split(',')[0]).sort(),
      ['1', '2', '4'],
      'the CSV lists the restaurant order numbers, not the shared ids',
    );
  });
});

describe('order numbers for orders that already exist (migration backfill)', () => {
  it('numbers old orders per restaurant in the order they were placed, and continues from there', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const before = files.filter((f) => f < '018');
    const old = await createDb({ pgliteDir: 'memory' });
    try {
      for (const f of before) await old.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      const vendor = async (name) => (await old.query(`INSERT INTO vendors (name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [name, `${name}@backfill.test`])).rows[0].id;
      const v1 = await vendor('one');
      const v2 = await vendor('two');
      const table = async (v) => (await old.query(`INSERT INTO dining_tables (vendor_id, number, capacity) VALUES ($1, 'B1', 2) RETURNING id`, [v])).rows[0].id;
      const [t1, t2] = [await table(v1), await table(v2)];
      const put = (v, t, at) => old.query(`INSERT INTO orders (vendor_id, table_id, table_number, subtotal_paise, tax_paise, total_paise, created_at) VALUES ($1, $2, 'B1', 100, 0, 100, $3)`, [v, t, at]);
      // Interleaved, and placed out of id order on purpose: the number follows when it was placed.
      await put(v1, t1, '2026-01-01 10:00:00+00');
      await put(v2, t2, '2026-01-01 10:01:00+00');
      await put(v1, t1, '2026-01-01 09:00:00+00');
      await put(v1, t1, '2026-01-01 11:00:00+00');
      await put(v2, t2, '2026-01-01 10:02:00+00');

      await old.exec(fs.readFileSync(path.join(dir, '018_order_number.sql'), 'utf8'));
      const rows = (await old.query(`SELECT vendor_id, order_no, created_at FROM orders ORDER BY vendor_id, order_no`)).rows;
      assert.deepEqual(rows.filter((r) => r.vendor_id === v1).map((r) => r.order_no), [1, 2, 3]);
      assert.deepEqual(rows.filter((r) => r.vendor_id === v2).map((r) => r.order_no), [1, 2]);
      const first = rows.find((r) => r.vendor_id === v1 && r.order_no === 1);
      assert.equal(new Date(first.created_at).toISOString(), '2026-01-01T09:00:00.000Z', 'the earliest order is #1');
      const next = (await old.query(`SELECT id, next_order_no FROM vendors ORDER BY id`)).rows;
      assert.deepEqual(next.map((r) => r.next_order_no), [4, 3]);
      await assert.rejects(() => old.query(`INSERT INTO orders (vendor_id, table_id, table_number, subtotal_paise, tax_paise, total_paise, order_no) VALUES ($1, $2, 'B1', 1, 0, 1, 1)`, [v1, t1]), 'the same number twice in one restaurant is refused');
    } finally {
      await old.close();
    }
  });
});

describe('the diner cancels their own order', () => {
  let token;
  let qr;
  let itemId;
  const place = async (pay_pref) => {
    const r = await api('POST', `/api/public/t/${qr}/orders`, { body: { pay_pref, items: [{ item_id: itemId, quantity: 1, option_ids: [] }] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };
  const cancel = (order) => api('POST', `/api/public/orders/${order.token}/cancel`);
  const view = async (order) => (await api('GET', `/api/public/orders/${order.token}`)).body.data;
  const adminId = async (order) => {
    const rows = (await api('GET', '/api/admin/orders?per_page=100', { token })).body.data;
    return rows.find((o) => o.number === order.number).id;
  };

  before(async () => {
    token = (await signupAccount({ name: 'Cancel Cafe', email: 'cancel.cafe@example.test', password: 'a-long-enough-password' })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data.id;
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'X1', capacity: 2 } })).body.data.qr_url.split('/').pop();
  });

  it('lets the diner cancel an order nobody has touched, and shows it as cancelled to the restaurant', async () => {
    const order = await place();
    assert.equal(order.can_cancel, true, 'a fresh order can be cancelled');
    const res = await cancel(order);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'cancelled');
    assert.equal(res.body.data.can_cancel, false);
    assert.equal((await view(order)).status, 'cancelled');
    const listed = (await api('GET', '/api/admin/orders?status=cancelled', { token })).body.data;
    assert.ok(listed.some((o) => o.number === order.number), 'the restaurant sees it under Cancelled');
    assert.equal((await cancel(order)).status, 200, 'asking again just answers with the cancelled order');
  });

  it('refuses once the kitchen has accepted the order', async () => {
    const order = await place();
    const id = await adminId(order);
    assert.equal((await api('PATCH', `/api/admin/orders/${id}/status`, { token, body: { status: 'accepted' } })).status, 200);
    assert.equal((await view(order)).can_cancel, false);
    const res = await cancel(order);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'CANNOT_CANCEL');
    assert.match(res.body.error.message, /kitchen/i);
    assert.equal((await view(order)).status, 'accepted', 'nothing changed');
  });

  it('refuses once an online payment was started, or the order is paid', async () => {
    const started = await place();
    const startedId = await adminId(started);
    await db.query(`INSERT INTO payments (order_id, provider, provider_order_id, amount_paise, status) VALUES ($1, 'razorpay', 'order_x', 2000, 'created')`, [startedId]);
    assert.equal((await view(started)).can_cancel, false);
    assert.equal((await cancel(started)).status, 409);

    const paid = await place();
    const paidId = await adminId(paid);
    assert.equal((await api('POST', `/api/admin/orders/${paidId}/cash-payment`, { token })).status, 200);
    const afterPaid = await cancel(paid);
    assert.equal(afterPaid.status, 409);
    assert.match(afterPaid.body.error.message, /already paid/i);
    assert.equal((await view(paid)).status, 'pending', 'a paid order is left alone');
  });

  it('answers 404 for an order that does not exist', async () => {
    assert.equal((await api('POST', '/api/public/orders/00000000-0000-4000-8000-000000000000/cancel')).status, 404);
    assert.equal((await api('POST', '/api/public/orders/not-a-token/cancel')).status, 404);
  });
});

describe("kitchen login: the kitchen's own sign-in that opens the kitchen screen and nothing else", () => {
  const PASSWORD = 'a-long-enough-password';
  const KITCHEN = 'kitchen.pass@mezmitra.test';
  let owner; // the restaurant's own login
  let kitchen; // the kitchen's token
  let tableQr;
  let itemId;
  const placeOrder = async () => (await api('POST', `/api/public/t/${tableQr}/orders`, { body: { items: [{ item_id: itemId, quantity: 2, option_ids: [] }], note: '', pay_pref: 'counter' }, headers: { 'Idempotency-Key': `k-${Math.random()}` } })).body.data;

  before(async () => {
    owner = (await signupAccount({ name: 'Pass Cafe', email: 'pass.cafe@mezmitra.test', password: PASSWORD })).body.data;
    const cat = (await api('POST', '/api/admin/categories', { token: owner.token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token: owner.token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data.id;
    tableQr = (await api('POST', '/api/admin/tables', { token: owner.token, body: { number: 'K1', capacity: 2 } })).body.data.qr_url.split('/').pop();
  });

  it('is set up, changed and removed by the restaurant, with the same rules as any login', async () => {
    const start = await api('GET', '/api/admin/kitchen-login', { token: owner.token });
    assert.deepEqual(start.body.data, { configured: false, email: null, created_at: null });

    const noPassword = await api('PUT', '/api/admin/kitchen-login', { token: owner.token, body: { email: KITCHEN } });
    assert.equal(noPassword.status, 409);
    assert.equal(noPassword.body.error.code, 'PASSWORD_REQUIRED');
    assert.equal((await api('PUT', '/api/admin/kitchen-login', { token: owner.token, body: { email: KITCHEN, password: 'short' } })).status, 400);
    assert.equal((await api('PUT', '/api/admin/kitchen-login', { token: owner.token, body: { email: 'not-an-email', password: PASSWORD } })).status, 400);
    // The restaurant's own address, and another restaurant's, are taken.
    const own = await api('PUT', '/api/admin/kitchen-login', { token: owner.token, body: { email: 'PASS.cafe@mezmitra.test', password: PASSWORD } });
    assert.equal(own.status, 409);
    assert.equal(own.body.error.code, 'EMAIL_UNAVAILABLE');
    assert.equal((await api('PUT', '/api/admin/kitchen-login', { token: owner.token, body: { email: 'owner@spice.test', password: PASSWORD } })).status, 409);

    const made = await api('PUT', '/api/admin/kitchen-login', { token: owner.token, body: { email: 'Kitchen.Pass@Mezmitra.test', password: PASSWORD } });
    assert.equal(made.status, 200);
    assert.equal(made.body.data.configured, true);
    assert.equal(made.body.data.email, KITCHEN);
    assert.equal(JSON.stringify(made.body).includes(PASSWORD), false, 'the password is never echoed back');
    assert.equal((await api('GET', '/api/admin/kitchen-login', { token: owner.token })).body.data.email, KITCHEN);

    // One address is one login: nobody else can take the kitchen's address, even by making a restaurant with it.
    const { emailInUse } = await import('../src/lib/accounts.js');
    assert.equal(await emailInUse(db, KITCHEN), true);
    assert.equal(await emailInUse(db, 'nobody.at.all@mezmitra.test'), false);
    const other = (await signupAccount({ name: 'Second Cafe', email: 'second.pass@mezmitra.test', password: PASSWORD })).body.data;
    const clash = await api('PUT', '/api/admin/kitchen-login', { token: other.token, body: { email: KITCHEN, password: PASSWORD } });
    assert.equal(clash.status, 409);
  });

  it('signs in as the kitchen, and the sign-in says so', async () => {
    const wrong = await api('POST', '/api/auth/login', { body: { email: KITCHEN, password: 'wrong-password-1' } });
    assert.equal(wrong.status, 401);
    const login = await api('POST', '/api/auth/login', { body: { email: KITCHEN, password: PASSWORD } });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.vendor.role, 'kitchen');
    assert.equal(login.body.data.vendor.email, KITCHEN);
    assert.equal(login.body.data.vendor.name, 'Pass Cafe');
    assert.equal(login.body.data.vendor.is_super_admin, false);
    kitchen = login.body.data.token;
    const me = (await api('GET', '/api/auth/me', { token: kitchen })).body.data;
    assert.equal(me.role, 'kitchen');
    // The restaurant's own login still works and is the owner kind.
    const own = await api('POST', '/api/auth/login', { body: { email: 'pass.cafe@mezmitra.test', password: PASSWORD } });
    assert.equal(own.body.data.vendor.role, 'owner');
  });

  it('can work with orders and nothing else', async () => {
    const o1 = await placeOrder();
    const list = await api('GET', '/api/admin/orders?status=active', { token: kitchen });
    assert.equal(list.status, 200);
    const id = list.body.data.find((o) => o.number === o1.number).id;
    assert.equal((await api('GET', `/api/admin/orders/${id}`, { token: kitchen })).status, 200);
    assert.equal((await api('PATCH', `/api/admin/orders/${id}/status`, { token: kitchen, body: { status: 'accepted' } })).status, 200);
    assert.equal((await api('POST', `/api/admin/orders/${id}/ready`, { token: kitchen })).status, 200);
    // Completing an order is staff taking the money: not the kitchen's.
    assert.equal((await api('PATCH', `/api/admin/orders/${id}/status`, { token: kitchen, body: { status: 'completed' } })).status, 403);
    // The kitchen may refuse an order it has not made yet.
    const o2 = await placeOrder();
    const id2 = (await api('GET', '/api/admin/orders?status=active', { token: kitchen })).body.data.find((o) => o.number === o2.number).id;
    assert.equal((await api('PATCH', `/api/admin/orders/${id2}/status`, { token: kitchen, body: { status: 'cancelled' } })).status, 200);

    for (const [method, path, body] of [
      ['GET', '/api/admin/categories'],
      ['GET', '/api/admin/items'],
      ['POST', '/api/admin/items', { category_id: 1, name: 'X', price: 1 }],
      ['GET', '/api/admin/tables'],
      ['GET', '/api/admin/payment-settings'],
      ['PUT', '/api/admin/payment-settings', { cash_enabled: false }],
      ['GET', '/api/admin/dashboard'],
      ['GET', '/api/admin/reports/summary'],
      ['GET', '/api/admin/vendor'],
      ['PATCH', '/api/admin/vendor', { name: 'Hijacked' }],
      ['GET', '/api/admin/requests'],
      ['GET', `/api/admin/orders/${id}/receipt.pdf`],
      ['POST', `/api/admin/orders/${id}/refund`, {}],
      ['GET', '/api/admin/kitchen-login'],
      ['PUT', '/api/admin/kitchen-login', { email: 'x.kitchen@mezmitra.test', password: PASSWORD }],
      ['DELETE', '/api/admin/kitchen-login'],
      ['POST', '/api/auth/change-password', { current_password: PASSWORD, new_password: 'another-long-password' }],
      ['GET', '/api/platform/overview'],
    ]) {
      const r = await api(method, path, { token: kitchen, body });
      assert.equal(r.status, 403, `${method} ${path} must be closed to the kitchen login (got ${r.status})`);
    }
    // Even when the restaurant is the platform owner's own: the kitchen login is not the owner.
    config.superAdminEmails = new Set(['pass.cafe@mezmitra.test']);
    try {
      assert.equal((await api('GET', '/api/platform/overview', { token: kitchen })).status, 403);
      assert.equal((await api('GET', '/api/platform/overview', { token: owner.token })).status, 200, 'while the restaurant login is the owner');
    } finally {
      config.superAdminEmails = new Set();
    }
  });

  it('is signed out by a new password, keeps its session when only the email changes, and stops when removed', async () => {
    // Only the email changes: the password and the open session stay.
    const moved = await api('PUT', '/api/admin/kitchen-login', { token: owner.token, body: { email: 'kitchen.pass2@mezmitra.test' } });
    assert.equal(moved.status, 200);
    assert.equal((await api('GET', '/api/admin/orders', { token: kitchen })).status, 200, 'the open session is not signed out by an email change');
    assert.equal((await api('POST', '/api/auth/login', { body: { email: KITCHEN, password: PASSWORD } })).status, 401, 'the old address no longer signs in');
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'kitchen.pass2@mezmitra.test', password: PASSWORD } })).status, 200);

    // A new password signs the kitchen out everywhere.
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await api('PUT', '/api/admin/kitchen-login', { token: owner.token, body: { email: 'kitchen.pass2@mezmitra.test', password: 'brand-new-kitchen-pass' } })).status, 200);
    assert.equal((await api('GET', '/api/admin/orders', { token: kitchen })).status, 401);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'kitchen.pass2@mezmitra.test', password: PASSWORD } })).status, 401);
    const again = await api('POST', '/api/auth/login', { body: { email: 'kitchen.pass2@mezmitra.test', password: 'brand-new-kitchen-pass' } });
    assert.equal(again.status, 200);
    kitchen = again.body.data.token;

    // A suspended restaurant's kitchen is turned away too.
    await db.query(`UPDATE vendors SET suspended_at = now() WHERE id = $1`, [owner.vendor.id]);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'kitchen.pass2@mezmitra.test', password: 'brand-new-kitchen-pass' } })).status, 403);
    assert.equal((await api('GET', '/api/admin/orders', { token: kitchen })).status, 403);
    await db.query(`UPDATE vendors SET suspended_at = NULL WHERE id = $1`, [owner.vendor.id]);

    // Removing the login ends it at once.
    assert.equal((await api('DELETE', '/api/admin/kitchen-login', { token: owner.token })).status, 200);
    assert.equal((await api('GET', '/api/admin/orders', { token: kitchen })).status, 401);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'kitchen.pass2@mezmitra.test', password: 'brand-new-kitchen-pass' } })).status, 401);
    assert.equal((await api('DELETE', '/api/admin/kitchen-login', { token: owner.token })).status, 404);
    assert.equal((await api('GET', '/api/admin/kitchen-login', { token: owner.token })).body.data.configured, false);
  });

  it('goes away with the restaurant', async () => {
    const r = (await signupAccount({ name: 'Short Lived Cafe', email: 'short.lived@mezmitra.test', password: PASSWORD })).body.data;
    await api('PUT', '/api/admin/kitchen-login', { token: r.token, body: { email: 'short.lived.kitchen@mezmitra.test', password: PASSWORD } });
    assert.equal((await db.query(`SELECT 1 FROM vendor_staff WHERE vendor_id = $1`, [r.vendor.id])).rowCount, 1);
    await db.query(`DELETE FROM vendors WHERE id = $1`, [r.vendor.id]);
    assert.equal((await db.query(`SELECT 1 FROM vendor_staff WHERE vendor_id = $1`, [r.vendor.id])).rowCount, 0);
  });
});

describe('the orders page figures: counts by state, the preparing and ready filters, and the dish photo on an order', () => {
  let token;
  let qr;
  let dishId;
  const order = async (qty = 1) => (await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: dishId, quantity: qty, option_ids: [] }], note: '', pay_pref: 'counter' }, headers: { 'Idempotency-Key': `k-${Math.random()}` } })).body.data;
  const idOf = async (number) => (await api('GET', '/api/admin/orders?per_page=100', { token })).body.data.find((o) => o.number === number).id;

  before(async () => {
    token = (await signupAccount({ name: 'Counts Cafe', email: 'counts.cafe@mezmitra.test', password: 'a-long-enough-password' })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    dishId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data.id;
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'C1', capacity: 2 } })).body.data.qr_url.split('/').pop();
  });

  it('counts every state, and the two halves of an accepted order are told apart', async () => {
    const zero = (await api('GET', '/api/admin/orders/counts', { token })).body.data;
    assert.deepEqual(zero, { all: 0, pending: 0, preparing: 0, ready: 0, completed: 0, cancelled: 0, active: 0 });

    // One table holds one open order, so finish one before the next is placed.
    const cancelled = await order();
    await api('PATCH', `/api/admin/orders/${await idOf(cancelled.number)}/status`, { token, body: { status: 'cancelled' } });
    const done = await order();
    const doneId = await idOf(done.number);
    await api('PATCH', `/api/admin/orders/${doneId}/status`, { token, body: { status: 'accepted' } });
    await api('POST', `/api/admin/orders/${doneId}/cash-payment`, { token });
    await api('PATCH', `/api/admin/orders/${doneId}/status`, { token, body: { status: 'completed' } });
    const ready = await order();
    const readyId = await idOf(ready.number);
    await api('PATCH', `/api/admin/orders/${readyId}/status`, { token, body: { status: 'accepted' } });
    await api('POST', `/api/admin/orders/${readyId}/ready`, { token });
    // Other tables for the open ones.
    const mk = async (n) => (await api('POST', '/api/admin/tables', { token, body: { number: n, capacity: 2 } })).body.data.qr_url.split('/').pop();
    const place = async (tableQr) => (await api('POST', `/api/public/t/${tableQr}/orders`, { body: { items: [{ item_id: dishId, quantity: 1, option_ids: [] }], note: '', pay_pref: 'counter' }, headers: { 'Idempotency-Key': `k-${Math.random()}` } })).body.data;
    const cooking = await place(await mk('C2'));
    await api('PATCH', `/api/admin/orders/${await idOf(cooking.number)}/status`, { token, body: { status: 'accepted' } });
    const pending = await place(await mk('C3')); // stays pending

    assert.deepEqual((await api('GET', '/api/admin/orders/counts', { token })).body.data, { all: 5, pending: 1, preparing: 1, ready: 1, completed: 1, cancelled: 1, active: 3 });
    const numbers = async (status) => (await api('GET', `/api/admin/orders?status=${status}`, { token })).body.data.map((o) => o.number).sort();
    assert.deepEqual(await numbers('pending'), [pending.number]);
    assert.deepEqual(await numbers('preparing'), [cooking.number]);
    assert.deepEqual(await numbers('ready'), [ready.number]);
    assert.deepEqual(await numbers('completed'), [done.number]);
    assert.deepEqual(await numbers('cancelled'), [cancelled.number]);
    assert.equal((await api('GET', '/api/admin/orders?status=active', { token })).body.data.length, 3);
    assert.equal((await api('GET', '/api/admin/orders?status=bogus', { token })).status, 400);
    // Only this restaurant's orders are counted.
    const other = (await signupAccount({ name: 'Counts Other', email: 'counts.other@mezmitra.test', password: 'a-long-enough-password' })).body.data.token;
    assert.equal((await api('GET', '/api/admin/orders/counts', { token: other })).body.data.all, 0);
    assert.equal((await api('GET', '/api/admin/orders/counts')).status, 401);
  });

  it('puts the dish photo on the order items, and none while the dish has no photo', async () => {
    const any = (await api('GET', '/api/admin/orders?per_page=5', { token })).body.data[0];
    assert.equal(any.items[0].photo_url, null);
    const up = await api('PUT', `/api/admin/items/${dishId}/photo`, { token, raw: PNG_1X1, headers: { 'Content-Type': 'image/png' } });
    assert.equal(up.status, 200);
    const after = (await api('GET', `/api/admin/orders/${any.id}`, { token })).body.data;
    assert.match(after.items[0].photo_url, /^\/api\/public\/items\/\d+\/photo\?v=1$/);
  });

  it('shows the dashboard figures: orders today, the live split, the average paid order, and photos on latest orders and top sellers', async () => {
    const d = (await api('GET', '/api/admin/dashboard/overview', { token })).body.data;
    // Five orders were placed, one of them cancelled.
    assert.equal(d.today_orders, 4);
    assert.deepEqual([d.live_pending, d.live_preparing, d.live_ready, d.live_orders], [1, 1, 1, 3]);
    const completed = (await api('GET', '/api/admin/orders?status=completed', { token })).body.data[0];
    assert.equal(d.average_order, completed.total, 'the average of the only paid order is that order');
    assert.equal(d.latest_orders.length, 5);
    for (const o of d.latest_orders) assert.match(o.items[0].photo_url, /^\/api\/public\/items\/\d+\/photo\?v=1$/);
    assert.equal(d.latest_orders.filter((o) => o.ready_at).length, 1, 'only the ready order carries a ready time');
    assert.match(d.top_selling[0].photo_url, /^\/api\/public\/items\/\d+\/photo\?v=1$/);
    // Another restaurant sees none of it.
    const other = (await signupAccount({ name: 'Dash Other', email: 'dash.other@mezmitra.test', password: 'a-long-enough-password' })).body.data.token;
    const o = (await api('GET', '/api/admin/dashboard/overview', { token: other })).body.data;
    assert.deepEqual([o.today_orders, o.average_order, o.live_orders, o.latest_orders.length, o.top_selling.length], [0, 0, 0, 0, 0]);
  });
});

describe('UPI, Cashfree and Paytm were removed: nothing breaks for restaurants that had them', () => {
  let token;
  let vendorId;
  let qr;
  let itemId;

  before(async () => {
    const su = await signupAccount({ name: 'Old Ways Cafe', email: 'old.ways@example.test', password: 'a-long-enough-password' });
    token = su.body.data.token;
    vendorId = su.body.data.vendor.id;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 20 } })).body.data.id;
    qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'O1', capacity: 2 } })).body.data.qr_url.split('/').pop();
  });

  it('starts with a deployment that still lists a removed method, ignoring it, and still refuses a made-up one', async () => {
    const { execFileSync } = await import('node:child_process');
    const run = (value) =>
      execFileSync(process.execPath, ['-e', "import('./src/config.js').then(({ config }) => console.log([...config.paymentMethods].join()))"], {
        env: { ...process.env, PAYMENT_METHODS: value, NODE_ENV: 'test', DATABASE_URL: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .toString()
        .trim();
    assert.equal(run('upi,cash,razorpay,phonepe'), 'cash,razorpay,phonepe', 'the live setting keeps working');
    assert.equal(run('upi'), 'cash', 'only removed ones: cash, so orders can still be taken');
    assert.equal(run('razorpay'), 'razorpay');
    assert.throws(() => run('bitcoin'));
  });

  it('does not offer or accept the removed ways of paying', async () => {
    const menu = (await api('GET', `/api/public/t/${qr}`)).body.data;
    assert.deepEqual(menu.payment_options, { cash: true, razorpay: false, phonepe: false });
    assert.equal((await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: itemId, quantity: 1, option_ids: [] }], pay_pref: 'upi' } })).status, 400);
    const settings = (await api('GET', '/api/admin/payment-settings', { token })).body.data;
    for (const key of Object.keys(settings)) assert.doesNotMatch(key, /^(upi|cashfree|paytm)_/);
    const placed = (await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: itemId, quantity: 1, option_ids: [] }] } })).body.data;
    assert.equal('upi' in placed, false);
    assert.equal('payment_claim' in placed, false);
    for (const path of ['upi-claim', 'cashfree', 'cashfree/verify']) assert.equal((await api('POST', `/api/public/orders/${placed.token}/${path}`, { body: {} })).status, 404, path);
    assert.equal((await api('POST', `/api/public/orders/${placed.token}/pay/paytm`)).status, 404);
    assert.equal((await api('GET', `/api/public/vendors/${vendorId}/upi-qr`)).status, 404);
  });

  it('switches cash on for a restaurant that would be left with no way to be paid (migration 026), and leaves others alone', async () => {
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(new URL('../migrations/026_upi_cashfree_paytm_removed.sql', import.meta.url), 'utf8');
    const other = (await signupAccount({ name: 'Keys Cafe', email: 'keys.cafe@example.test', password: 'a-long-enough-password' })).body.data;
    await api('GET', '/api/admin/payment-settings', { token: other.token });
    // This one took only UPI; the other has Razorpay set up and had switched cash off on purpose.
    await api('GET', '/api/admin/payment-settings', { token });
    await db.query(`UPDATE vendor_payment_settings SET cash_enabled = false, upi_enabled = true, upi_id = 'old@okbank' WHERE vendor_id = $1`, [vendorId]);
    await db.query(
      `UPDATE vendor_payment_settings SET cash_enabled = false, razorpay_enabled = true, razorpay_key_id = 'rzp_test_abcdef123', razorpay_key_secret_enc = 'x' WHERE vendor_id = $1`,
      [other.vendor.id],
    );
    await db.query(sql);
    const cashOf = async (id) => (await db.query(`SELECT cash_enabled, upi_id FROM vendor_payment_settings WHERE vendor_id = $1`, [id])).rows[0];
    assert.equal((await cashOf(vendorId)).cash_enabled, true);
    assert.equal((await cashOf(vendorId)).upi_id, 'old@okbank', 'nothing old is deleted');
    assert.equal((await cashOf(other.vendor.id)).cash_enabled, false);
  });

  it('switches PhonePe off where sandbox keys were saved, with cash on instead (migration 027)', async () => {
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(new URL('../migrations/027_phonepe_live_only.sql', import.meta.url), 'utf8');
    const live = (await signupAccount({ name: 'Live Keys Cafe', email: 'live.keys@example.test', password: 'a-long-enough-password' })).body.data;
    await api('GET', '/api/admin/payment-settings', { token: live.token });
    await api('GET', '/api/admin/payment-settings', { token });
    const withKeys = `UPDATE vendor_payment_settings SET cash_enabled = false, razorpay_enabled = false, phonepe_enabled = true,
        phonepe_client_id = 'MERCHANT_1', phonepe_client_version = '1', phonepe_secret_enc = 'x', phonepe_env = $2 WHERE vendor_id = $1`;
    await db.query(withKeys, [vendorId, 'sandbox']);
    await db.query(withKeys, [live.vendor.id, 'live']);
    await db.exec(sql); // several statements, run the way the migrator runs them
    const of = async (id) =>
      (await db.query(`SELECT cash_enabled, phonepe_enabled, phonepe_client_id, phonepe_env FROM vendor_payment_settings WHERE vendor_id = $1`, [id])).rows[0];
    assert.deepEqual(await of(vendorId), { cash_enabled: true, phonepe_enabled: false, phonepe_client_id: 'MERCHANT_1', phonepe_env: 'live' });
    assert.deepEqual(await of(live.vendor.id), { cash_enabled: false, phonepe_enabled: true, phonepe_client_id: 'MERCHANT_1', phonepe_env: 'live' });
  });

  it('switches Razorpay off where a test key was saved, with cash on instead (migration 028)', async () => {
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(new URL('../migrations/028_razorpay_live_keys_only.sql', import.meta.url), 'utf8');
    const live = (await signupAccount({ name: 'Live Razorpay Cafe', email: 'live.razorpay@example.test', password: 'a-long-enough-password' })).body.data;
    await api('GET', '/api/admin/payment-settings', { token: live.token });
    await api('GET', '/api/admin/payment-settings', { token });
    const withKey = `UPDATE vendor_payment_settings SET cash_enabled = false, phonepe_enabled = false, razorpay_enabled = true,
        razorpay_key_id = $2, razorpay_key_secret_enc = 'x' WHERE vendor_id = $1`;
    await db.query(withKey, [vendorId, 'rzp_test_abcdef123']);
    await db.query(withKey, [live.vendor.id, 'rzp_live_abcdef123']);
    await db.exec(sql);
    const of = async (id) =>
      (await db.query(`SELECT cash_enabled, razorpay_enabled, razorpay_key_id FROM vendor_payment_settings WHERE vendor_id = $1`, [id])).rows[0];
    assert.deepEqual(await of(vendorId), { cash_enabled: true, razorpay_enabled: false, razorpay_key_id: 'rzp_test_abcdef123' });
    assert.deepEqual(await of(live.vendor.id), { cash_enabled: false, razorpay_enabled: true, razorpay_key_id: 'rzp_live_abcdef123' });
  });

  it('still shows how an older order was paid, in the reports and on its receipt', async () => {
    const placed = (await api('POST', `/api/public/t/${qr}/orders`, { body: { items: [{ item_id: itemId, quantity: 1, option_ids: [] }] } })).body.data;
    const row = (await db.query(`UPDATE orders SET payment_status = 'paid', payment_method = 'upi', paid_at = now() WHERE public_token = $1 RETURNING id`, [placed.token])).rows[0];
    const summary = (await api('GET', '/api/admin/reports/summary', { token })).body.data;
    assert.deepEqual(summary.sales.by_method.map((m) => m.method), ['cash', 'razorpay', 'phonepe', 'upi']);
    assert.equal(Math.round(summary.sales.by_method.reduce((n, m) => n + m.amount, 0) * 100), Math.round(summary.sales.total * 100), 'totals still add up');
    const dash = (await api('GET', '/api/admin/dashboard/overview', { token })).body.data;
    assert.equal(dash.payment_methods.at(-1).method, 'upi');
    assert.equal((await api('GET', `/api/admin/orders/${row.id}/receipt.pdf`, { token })).status, 200);
    const refund = await api('POST', `/api/admin/orders/${row.id}/refund`, { token });
    assert.equal(refund.body.error.code, 'REFUND_MANUAL');
  });
});

describe('money is counted once, and a second payment is never lost', () => {
  const PASSWORD = 'a-long-enough-password';
  const RZ_SECRET = 'secret-value-123';
  const HOOK_SECRET = 'hook-secret-1234';
  const ppAuth = createHash('sha256').update('twice-user:twice-password').digest('hex');
  const ppOrders = new Map(); // fake PhonePe: merchantOrderId -> { amount, state }
  const ppRefunds = [];
  const quiet = { info: () => {}, warn: () => {} };
  let phonepe;
  let savedBase;
  let rz; // the Razorpay restaurant
  let pp; // the PhonePe restaurant

  const setup = async (name, email, settings) => {
    const token = (await signupAccount({ name, email, password: PASSWORD })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    const item = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 40 } })).body.data;
    const qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'M1', capacity: 2 } })).body.data.qr_url.split('/').pop();
    const saved = await api('PUT', '/api/admin/payment-settings', { token, body: settings });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    return { token, itemId: item.id, qr, hookKey: saved.body.data.webhook_url_razorpay.split('/').pop() };
  };
  const place = async (r) => {
    const res = await api('POST', `/api/public/t/${r.qr}/orders`, { body: { pay_pref: 'online', items: [{ item_id: r.itemId, quantity: 1, option_ids: [] }] } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };
  const view = async (order) => (await api('GET', `/api/public/orders/${order.token}`)).body.data;
  const idOf = async (order) => (await db.query(`SELECT id FROM orders WHERE public_token = $1`, [order.token])).rows[0].id;
  const rows = async (order) => (await db.query(`SELECT * FROM payments WHERE order_id = $1 ORDER BY id`, [await idOf(order)])).rows;
  const adminView = async (r, order) => (await api('GET', `/api/admin/orders/${await idOf(order)}`, { token: r.token })).body.data;
  const cash = async (r, order) => assert.equal((await api('POST', `/api/admin/orders/${await idOf(order)}/cash-payment`, { token: r.token })).status, 200);

  // What the Razorpay checkout window hands back to the order page.
  const checkoutReply = async (order, paymentId, fake) => {
    const start = (await api('POST', `/api/public/orders/${order.token}/razorpay`)).body.data;
    if (fake) rzpPayments.set(paymentId, { amount: start.amount_paise, order_id: start.razorpay_order_id, ...fake });
    const signature = createHmac('sha256', RZ_SECRET).update(`${start.razorpay_order_id}|${paymentId}`).digest('hex');
    return { razorpay_order_id: start.razorpay_order_id, razorpay_payment_id: paymentId, razorpay_signature: signature };
  };
  const verify = (order, body) => api('POST', `/api/public/orders/${order.token}/razorpay/verify`, { body });
  const rzHook = (r, orderId, amount, paymentId) => {
    const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, status: 'captured' } } } });
    const signature = createHmac('sha256', HOOK_SECRET).update(raw).digest('hex');
    return api('POST', `/api/webhooks/razorpay/${r.hookKey}`, { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature } });
  };
  const captures = (paymentId) => razorpayCalls.filter((c) => c.method === 'POST' && c.url.endsWith(`/payments/${paymentId}/capture`)).length;
  const openPage = (order) => api('POST', `/api/public/orders/${order.token}/pay/phonepe`);
  const ppVerify = (order) => api('POST', `/api/public/orders/${order.token}/pay/phonepe/verify`);
  const ppHook = (r, merchantOrderId) =>
    api('POST', `/api/webhooks/phonepe/${r.hookKey}`, { body: { event: 'checkout.order.completed', payload: { merchantOrderId } }, headers: { Authorization: ppAuth } });

  before(async () => {
    phonepe = await new Promise((resolve) => {
      const server = http
        .createServer((req, res) => {
          let raw = '';
          req.on('data', (c) => (raw += c));
          req.on('end', () => {
            const path = req.url.split('?')[0];
            const send = (status, body) => {
              res.statusCode = status;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(body));
            };
            if (path === '/v1/oauth/token') return send(200, { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 });
            if (path === '/checkout/v2/pay') {
              const body = JSON.parse(raw);
              ppOrders.set(body.merchantOrderId, { amount: body.amount, state: 'PENDING' });
              return send(200, { redirectUrl: `https://phonepe.example/pay/${body.merchantOrderId}` });
            }
            if (path === '/payments/v2/refund') {
              ppRefunds.push(JSON.parse(raw));
              return send(200, { refundId: `OMR_${ppRefunds.length}`, state: 'PENDING' });
            }
            const m = path.match(/^\/checkout\/v2\/order\/([^/]+)\/status$/);
            const found = m && ppOrders.get(decodeURIComponent(m[1]));
            if (!found) return send(404, { code: 'NOT_FOUND' });
            return send(200, { state: found.state, amount: found.amount, paymentDetails: [{ state: found.state, transactionId: `TXN_${m[1]}` }] });
          });
        })
        .listen(0, '127.0.0.1', () => resolve(server));
    });
    savedBase = config.phonepeApiBase;
    config.phonepeApiBase = `http://127.0.0.1:${phonepe.address().port}`;
    rz = await setup('Twice Razorpay Cafe', 'twice.razorpay@example.test', {
      razorpay_enabled: true,
      razorpay_key_id: 'rzp_test_abcdef123456',
      razorpay_key_secret: RZ_SECRET,
      razorpay_webhook_secret: HOOK_SECRET,
    });
    pp = await setup('Twice PhonePe Cafe', 'twice.phonepe@example.test', {
      phonepe_enabled: true,
      phonepe_client_id: 'TWICEMERCHANT',
      phonepe_client_version: '1',
      phonepe_client_secret: 'phonepe-client-secret-value',
      phonepe_webhook_username: 'twice-user',
      phonepe_webhook_password: 'twice-password',
    });
  });

  after(async () => {
    config.phonepeApiBase = savedBase;
    await new Promise((r) => phonepe.close(r));
  });

  it('captures a payment Razorpay only authorized, and only then calls the order paid', async () => {
    const order = await place(rz);
    const body = await checkoutReply(order, 'pay_AUTHONLY01', { status: 'authorized' });
    const r = await verify(order, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.payment_status, 'paid');
    assert.equal(captures('pay_AUTHONLY01'), 1);
  });

  it('leaves the order unpaid while the money is not captured, and asks the page to try again', async () => {
    const order = await place(rz);
    const body = await checkoutReply(order, 'pay_STUCK00001', { status: 'authorized', captureFails: true });
    const r = await verify(order, body);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'PAYMENT_NOT_CAPTURED');
    assert.equal((await view(order)).payment_status, 'unpaid');
    rzpPayments.get('pay_STUCK00001').status = 'failed';
    assert.equal((await verify(order, body)).status, 503);
    rzpPayments.get('pay_STUCK00001').status = 'captured';
    assert.equal((await verify(order, body)).body.data.payment_status, 'paid');
  });

  it("refuses a payment that is another order's or for less than this order", async () => {
    const order = await place(rz);
    const other = await checkoutReply(order, 'pay_OTHER00001', { status: 'captured', order_id: 'order_SOMEONEELSE' });
    assert.equal((await verify(order, other)).body.error.code, 'PAYMENT_NOT_FOUND');
    const short = await checkoutReply(order, 'pay_SHORT00001', { status: 'captured', amount: 100 });
    assert.equal((await verify(order, short)).body.error.code, 'PAYMENT_NOT_FOUND');
    assert.equal((await view(order)).payment_status, 'unpaid');
  });

  it('does not turn a refunded Razorpay order back to paid when the same reply is sent again', async () => {
    const order = await place(rz);
    const body = await checkoutReply(order, 'pay_REPLAY0001', { status: 'captured' });
    assert.equal((await verify(order, body)).body.data.payment_status, 'paid');
    assert.equal((await api('POST', `/api/admin/orders/${await idOf(order)}/refund`, { token: rz.token })).status, 200);
    const again = await verify(order, body);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.payment_status, 'refunded');
    assert.deepEqual((await rows(order)).map((p) => p.status), ['refunded']);
  });

  it('does not turn a refunded PhonePe order back to paid when its webhook arrives again', async () => {
    const order = await place(pp);
    await openPage(order);
    const [attempt] = await rows(order);
    ppOrders.get(attempt.provider_order_id).state = 'COMPLETED'; // PhonePe keeps saying so after a refund
    assert.equal((await ppVerify(order)).body.data.payment_status, 'paid');
    assert.equal((await api('POST', `/api/admin/orders/${await idOf(order)}/refund`, { token: pp.token })).status, 200);
    const hook = await ppHook(pp, attempt.provider_order_id);
    assert.equal(hook.body.data.paid, undefined);
    assert.equal(hook.body.data.already, true);
    assert.equal((await ppVerify(order)).body.data.payment_status, 'refunded');
    await reconcileOnce(db, { log: quiet });
    assert.equal((await view(order)).payment_status, 'refunded');
  });

  it('records an online payment that arrives after cash, shows it, and gives it back without touching the order', async () => {
    const order = await place(rz);
    const start = (await api('POST', `/api/public/orders/${order.token}/razorpay`)).body.data;
    await cash(rz, order);
    const hook = await rzHook(rz, start.razorpay_order_id, start.amount_paise, 'pay_SECOND0001');
    assert.deepEqual([hook.body.data.paid, hook.body.data.extra], [false, true]);
    assert.equal((await rzHook(rz, start.razorpay_order_id, start.amount_paise, 'pay_SECOND0001')).body.data.already, true);

    const seen = await adminView(rz, order);
    assert.equal(seen.payment_method, 'cash');
    assert.deepEqual(seen.extra_payments.map((p) => [p.method, p.amount, p.status]), [['razorpay', 40, 'paid']]);
    assert.equal((await view(order)).second_payment, true);
    const waiting = (await api('GET', '/api/admin/orders/attention', { token: rz.token })).body.data;
    const mine = waiting.find((p) => p.order_id === seen.id);
    assert.deepEqual([mine.kind, mine.order_number, mine.amount, mine.method], ['paid_twice', seen.number, 40, 'razorpay']);
    assert.ok(!(await api('GET', '/api/admin/orders/attention', { token: pp.token })).body.data.some((p) => p.order_id === seen.id));

    const path = `/api/admin/orders/${seen.id}/extra-payments/${seen.extra_payments[0].id}/refund`;
    assert.equal((await api('POST', path)).status, 401);
    assert.equal((await api('POST', path, { token: pp.token })).status, 404, "another restaurant cannot refund it");
    const asked = razorpayRefunds.length;
    const done = await api('POST', path, { token: rz.token });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(razorpayRefunds.length, asked + 1);
    assert.deepEqual(razorpayRefunds.at(-1), { payment: 'pay_SECOND0001', amount: 4000 });
    assert.deepEqual([done.body.data.payment_status, done.body.data.payment_method], ['paid', 'cash'], 'the order stays paid in cash');
    assert.equal(done.body.data.extra_payments[0].status, 'refunded');
    assert.equal((await view(order)).second_payment, false);
    assert.equal((await api('POST', path, { token: rz.token })).body.error.code, 'ALREADY_REFUNDED');
  });

  it('does not take a held payment for an order that was paid another way', async () => {
    const order = await place(rz);
    const body = await checkoutReply(order, 'pay_HELD000001', { status: 'authorized' });
    await cash(rz, order);
    const r = await verify(order, body);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'PAYMENT_NOT_TAKEN');
    assert.equal(captures('pay_HELD000001'), 0);
    assert.deepEqual((await rows(order)).map((p) => p.status).sort(), ['created', 'paid']);
  });

  it('refunds the payment that paid the order, not the second one', async () => {
    const order = await place(pp);
    await openPage(order);
    await openPage(order);
    const [first, second] = await rows(order);
    ppOrders.get(first.provider_order_id).state = 'COMPLETED';
    ppOrders.get(second.provider_order_id).state = 'COMPLETED';
    assert.equal((await ppVerify(order)).body.data.payment_status, 'paid');
    const after = await rows(order);
    assert.deepEqual(after.map((p) => p.status), ['paid', 'paid']);
    assert.equal(after.filter((p) => p.is_extra).length, 1);
    const counted = after.find((p) => !p.is_extra);
    assert.equal((await api('POST', `/api/admin/orders/${await idOf(order)}/refund`, { token: pp.token })).status, 200);
    assert.equal(ppRefunds.at(-1).originalMerchantOrderId, counted.provider_order_id);
    assert.equal((await rows(order)).find((p) => p.is_extra).status, 'paid', 'the second payment still waits to be given back');
  });

  it('finds a second payment on a paid order in the five-minute re-check', async () => {
    const order = await place(pp);
    await openPage(order);
    const [attempt] = await rows(order);
    await cash(pp, order);
    ppOrders.get(attempt.provider_order_id).state = 'COMPLETED';
    await db.query(`UPDATE payments SET created_at = now() - interval '10 minutes' WHERE id = $1`, [attempt.id]);
    await reconcileOnce(db, { log: quiet });
    const found = (await rows(order)).find((p) => p.provider === 'phonepe');
    assert.deepEqual([found.status, found.is_extra], ['paid', true]);
  });

  it('finds a payment made on an old PhonePe page, and limits how many pages one order can open', async () => {
    const order = await place(pp);
    for (let i = 0; i < 10; i += 1) assert.equal((await openPage(order)).status, 200);
    const stop = await openPage(order);
    assert.equal(stop.status, 409);
    assert.equal(stop.body.error.code, 'TOO_MANY_PAYMENT_TRIES');
    const [oldest] = await rows(order);
    ppOrders.get(oldest.provider_order_id).state = 'COMPLETED';
    const again = await openPage(order);
    assert.equal(again.body.error.code, 'ALREADY_PAID', 'never asked to pay twice');
    assert.equal((await view(order)).payment_status, 'paid');
  });
});

describe('rate limits count per visitor, across every instance of the API', () => {
  let one;
  let two; // a second instance on the same database
  const at = (s) => `http://127.0.0.1:${s.address().port}`;
  const login = (server, headers = {}, body = { email: 'nobody@example.test', password: 'not-the-password' }) =>
    fetch(`${at(server)}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const remaining = (res) => Number(/remaining=(\d+)/.exec(res.headers.get('ratelimit') ?? '')?.[1]);
  const reset = () => db.query(`DELETE FROM rate_limits`);

  before(async () => {
    one = await listen(createApp({ db, mailer: fakeMailer }));
    two = await listen(createApp({ db, mailer: fakeMailer }));
  });
  after(async () => {
    config.clientIpHeader = '';
    await reset();
    await new Promise((r) => one.close(r));
    await new Promise((r) => two.close(r));
  });

  it('counts down one counter for one address, whichever instance answers', async () => {
    await reset();
    const seen = [];
    for (let i = 0; i < 6; i += 1) seen.push(remaining(await login(i % 2 ? two : one)));
    assert.deepEqual(seen, [19, 18, 17, 16, 15, 14]);
    for (let i = 0; i < 14; i += 1) await login(one);
    assert.equal((await login(two)).status, 429, 'the 21st failed try is refused by the other instance too');
    assert.equal((await login(one)).status, 429);
  });

  it('ignores addresses a client makes up', async () => {
    await reset();
    const first = remaining(await login(one, { 'X-Forwarded-For': '203.0.113.1', 'CF-Connecting-IP': '203.0.113.2' }));
    const second = remaining(await login(one, { 'X-Forwarded-For': '203.0.113.3', 'CF-Connecting-IP': '203.0.113.4' }));
    assert.deepEqual([first, second], [19, 18]);
  });

  it("counts by the proxy's address header when one is configured, and falls back when it is not an address", async () => {
    await reset();
    config.clientIpHeader = 'cf-connecting-ip';
    try {
      const a1 = remaining(await login(one, { 'CF-Connecting-IP': '198.51.100.7', 'X-Forwarded-For': '10.0.0.1' }));
      const a2 = remaining(await login(two, { 'CF-Connecting-IP': '198.51.100.7', 'X-Forwarded-For': '10.9.9.9' }));
      const b1 = remaining(await login(one, { 'CF-Connecting-IP': '198.51.100.8' }));
      assert.deepEqual([a1, a2, b1], [19, 18, 19]);
      assert.equal(remaining(await login(one, { 'CF-Connecting-IP': 'not-an-address' })), 19);
      assert.equal(remaining(await login(one)), 18, 'without the header the connection address counts');
    } finally {
      config.clientIpHeader = '';
    }
  });

  it('does not use up the sign-in allowance with successful sign-ins', async () => {
    await reset();
    const email = 'limits.ok@example.test';
    await signupAccount({ name: 'Limits Cafe', email, password: 'a-long-enough-password' });
    for (let i = 0; i < 25; i += 1) assert.equal((await login(one, {}, { email, password: 'a-long-enough-password' })).status, 200);
    assert.equal(remaining(await login(one)), 19);
  });

  it('starts a new window when the old one has passed', async () => {
    await reset();
    for (let i = 0; i < 20; i += 1) await login(one);
    assert.equal((await login(one)).status, 429);
    await db.query(`UPDATE rate_limits SET reset_at = now() - interval '1 second'`);
    assert.equal((await login(one)).status, 401);
  });

  it('answers the health check without asking the database every time', async () => {
    const real = db.query;
    let asked = 0;
    db.query = (...args) => {
      asked += 1;
      return real(...args);
    };
    try {
      for (let i = 0; i < 20; i += 1) assert.equal((await fetch(`${at(one)}/api/health`)).status, 200);
    } finally {
      db.query = real;
    }
    assert.ok(asked <= 1, `${asked} database calls`);
  });

  it('does not fall over when taking a try back fails', async () => {
    const { DbRateStore } = await import('../src/lib/rateLimit.js');
    const store = new DbRateStore({ query: async () => Promise.reject(new Error('database is away')) }, 'login');
    const warn = console.warn;
    console.warn = () => {};
    try {
      await store.decrement('203.0.113.1'); // express-rate-limit does not wait for this: a rejection would stop the server
    } finally {
      console.warn = warn;
    }
  });

  it('stops one address that floods the payment webhook, far above what a gateway sends', async () => {
    const call = async () => {
      const res = await fetch(`${at(two)}/api/webhooks/razorpay/${'0'.repeat(32)}`, { method: 'POST', body: '{}' });
      await res.arrayBuffer();
      return res;
    };
    assert.match((await call()).headers.get('ratelimit'), /limit=1200/);
    for (let sent = 1; sent < 1200; sent += 100) await Promise.all(Array.from({ length: Math.min(100, 1200 - sent) }, call));
    assert.equal((await call()).status, 429);
  });
});

describe('the payment state machine: refunds that finish later, the re-check queue, the counter, and the record', () => {
  const PASSWORD = 'a-long-enough-password';
  const RZ_SECRET = 'secret-value-123';
  const quiet = { info: () => {}, warn: () => {} };
  // refundPlan: { answer: HTTP status to fail with, taken: false when it does not take the refund on, statusDown: true }
  const pp = { orders: new Map(), refundState: 'PENDING', refunds: new Map(), asked: [], refundPlan: null, refundCalls: 0, onRefund: null, onStatus: null };
  let phonepe;
  let savedBase;
  let ph; // the PhonePe restaurant
  let rz; // the Razorpay restaurant

  const setup = async (name, email, settings) => {
    const token = (await signupAccount({ name, email, password: PASSWORD })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    const item = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 40 } })).body.data;
    const table = (await api('POST', '/api/admin/tables', { token, body: { number: 'S1', capacity: 2 } })).body.data;
    const saved = await api('PUT', '/api/admin/payment-settings', { token, body: settings });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const vendorId = (await db.query(`SELECT id FROM vendors WHERE email = $1`, [email])).rows[0].id;
    return { token, vendorId, itemId: item.id, tableId: table.id, qr: table.qr_url.split('/').pop() };
  };
  const place = async (r) => {
    await db.query(`UPDATE orders SET status = 'cancelled' WHERE vendor_id = $1 AND status = 'pending' AND payment_status = 'unpaid' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id)`, [r.vendorId]);
    const res = await api('POST', `/api/public/t/${r.qr}/orders`, { body: { pay_pref: 'online', items: [{ item_id: r.itemId, quantity: 1, option_ids: [] }] } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };
  const view = async (order) => (await api('GET', `/api/public/orders/${order.token}`)).body.data;
  const idOf = async (order) => (await db.query(`SELECT id FROM orders WHERE public_token = $1`, [order.token])).rows[0].id;
  const rows = async (order) => (await db.query(`SELECT * FROM payments WHERE order_id = $1 ORDER BY id`, [await idOf(order)])).rows;
  const adminView = async (r, order) => (await api('GET', `/api/admin/orders/${await idOf(order)}`, { token: r.token })).body.data;
  const events = async (order) => (await db.query(`SELECT event, actor FROM audit_events WHERE order_id = $1 ORDER BY id`, [await idOf(order)])).rows;
  const openPage = (order) => api('POST', `/api/public/orders/${order.token}/pay/phonepe`);
  const ppVerify = (order) => api('POST', `/api/public/orders/${order.token}/pay/phonepe/verify`);
  const paidByPhonePe = async (order) => {
    assert.equal((await openPage(order)).status, 200);
    const [attempt] = await rows(order);
    pp.orders.get(attempt.provider_order_id).state = 'COMPLETED';
    assert.equal((await ppVerify(order)).body.data.payment_status, 'paid');
    return attempt;
  };
  const refund = async (r, order) => api('POST', `/api/admin/orders/${await idOf(order)}/refund`, { token: r.token });
  const ageRefunds = () => db.query(`UPDATE payments SET refund_checked_at = NULL WHERE refund_state = 'pending'`);
  const age = (order) => db.query(`UPDATE payments SET created_at = now() - interval '10 minutes' WHERE order_id IN (SELECT id FROM orders WHERE public_token = $1)`, [order.token]);

  before(async () => {
    phonepe = await new Promise((resolve) => {
      const server = http
        .createServer((req, res) => {
          let raw = '';
          req.on('data', (c) => (raw += c));
          req.on('end', () => {
            const path = req.url.split('?')[0];
            const send = (status, body) => {
              res.statusCode = status;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(body));
            };
            if (path === '/v1/oauth/token') return send(200, { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 });
            if (path === '/checkout/v2/pay') {
              const body = JSON.parse(raw);
              pp.orders.set(body.merchantOrderId, { amount: body.amount, state: 'PENDING' });
              return send(200, { redirectUrl: `https://phonepe.example/pay/${body.merchantOrderId}` });
            }
            if (path === '/payments/v2/refund') {
              const body = JSON.parse(raw);
              pp.refundCalls += 1;
              const answer = () => {
                if (pp.refunds.has(body.merchantRefundId)) return send(400, { code: 'DUPLICATE_REFUND' });
                if (pp.refundPlan?.taken !== false) pp.refunds.set(body.merchantRefundId, pp.refundState);
                if (pp.refundPlan?.answer) return send(pp.refundPlan.answer, { code: 'PLANNED' });
                return send(200, { refundId: `OMR_${pp.refunds.size}`, state: pp.refundState });
              };
              return pp.onRefund ? pp.onRefund().then(answer) : answer();
            }
            const status = path.match(/^\/payments\/v2\/refund\/([^/]+)\/status$/);
            if (status) {
              if (pp.refundPlan?.statusDown) return send(500, { code: 'DOWN' });
              const answer = () => {
                const state = pp.refunds.get(decodeURIComponent(status[1]));
                return state ? send(200, { state }) : send(404, { code: 'NOT_FOUND' });
              };
              return pp.onStatus ? pp.onStatus().then(answer) : answer();
            }
            const m = path.match(/^\/checkout\/v2\/order\/([^/]+)\/status$/);
            if (m) pp.asked.push(decodeURIComponent(m[1]));
            const found = m && pp.orders.get(decodeURIComponent(m[1]));
            if (!found) return send(404, { code: 'NOT_FOUND' });
            return send(200, { state: found.state, amount: found.amount, paymentDetails: [{ state: found.state, transactionId: `TXN_${m[1]}` }] });
          });
        })
        .listen(0, '127.0.0.1', () => resolve(server));
    });
    savedBase = config.phonepeApiBase;
    config.phonepeApiBase = `http://127.0.0.1:${phonepe.address().port}`;
    config.maxOpenOrdersPerTable = 1000; // these tests pile many orders onto one table on purpose
    ph = await setup('State PhonePe Cafe', 'state.phonepe@example.test', {
      phonepe_enabled: true,
      phonepe_client_id: 'STATEMERCHANT',
      phonepe_client_version: '1',
      phonepe_client_secret: 'phonepe-client-secret-value',
    });
    rz = await setup('State Razorpay Cafe', 'state.razorpay@example.test', { razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: RZ_SECRET });
  });

  after(async () => {
    config.maxOpenOrdersPerTable = 12;
    config.phonepeApiBase = savedBase;
    await new Promise((r) => phonepe.close(r));
  });

  const ageRequest = (order, minutes) =>
    db.query(`UPDATE payments SET refund_requested_at = now() - make_interval(mins => $2), refund_checked_at = NULL WHERE order_id = (SELECT id FROM orders WHERE public_token = $1)`, [order.token, minutes]);
  const states = async (order) => (await rows(order)).map((p) => [p.status, p.refund_state]);
  const refundWith = async (plan, order) => {
    pp.refundPlan = plan;
    try {
      return await refund(ph, order);
    } finally {
      pp.refundPlan = null;
    }
  };

  it('records a refund the gateway took although its answer never arrived', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    const r = await refundWith({ answer: 500 }, order);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await states(order), [['refunded', 'pending']]);
    assert.equal((await view(order)).payment_status, 'refunded');
  });

  it('says a refund is unconfirmed, never asks twice, and records it once the gateway can be asked', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    const calls = pp.refundCalls;
    const first = await refundWith({ answer: 500, statusDown: true }, order);
    assert.deepEqual([first.status, first.body.error.code], [502, 'REFUND_UNCONFIRMED']);
    assert.deepEqual(await states(order), [['paid', 'requested']]);
    assert.equal((await adminView(ph, order)).refund_state, 'requested');
    assert.equal((await refund(ph, order)).body.error.code, 'REFUND_IN_PROGRESS');
    assert.equal((await api('POST', `/api/admin/orders/${await idOf(order)}/cash-payment`, { token: ph.token })).body.error.code, 'ALREADY_PAID');
    await ageRequest(order, 6);
    const later = await refund(ph, order);
    assert.equal(later.status, 200, JSON.stringify(later.body));
    assert.equal(pp.refundCalls - calls, 1, 'the gateway was asked for the money once');
    assert.deepEqual(await states(order), [['refunded', 'pending']]);
  });

  it('settles an unconfirmed refund by itself, from the re-check', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    await refundWith({ answer: 500, statusDown: true }, order);
    await reconcileRefunds(db, { log: quiet });
    assert.deepEqual(await states(order), [['paid', 'requested']], 'not while the request may still be running');
    await ageRequest(order, 6);
    await reconcileRefunds(db, { log: quiet });
    assert.deepEqual(await states(order), [['refunded', 'pending']]);
    assert.equal((await view(order)).payment_status, 'refunded');
  });

  it('calls a refund failed when the gateway never took it, and lets staff try again', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    await refundWith({ answer: 500, taken: false, statusDown: true }, order);
    await ageRequest(order, 6);
    await reconcileRefunds(db, { log: quiet });
    assert.deepEqual(await states(order), [['paid', 'requested']], 'a few minutes with nothing there is not yet a failure');
    await ageRequest(order, 11);
    await reconcileRefunds(db, { log: quiet });
    assert.deepEqual(await states(order), [['paid', 'failed']]);
    assert.ok((await api('GET', '/api/admin/orders/attention', { token: ph.token })).body.data.some((a) => a.kind === 'refund_failed' && a.order_number === order.number));
    assert.equal((await refund(ph, order)).status, 200);
    assert.deepEqual(await states(order), [['refunded', 'pending']]);
  });

  it('does not let the re-check close a request staff have just made again', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    await refundWith({ answer: 500, taken: false, statusDown: true }, order);
    await ageRequest(order, 11);
    // While the re-check is asking PhonePe, staff press Refund: the request is new again.
    pp.onStatus = () => db.query(`UPDATE payments SET refund_requested_at = now() WHERE order_id = $1`, [orderId]);
    const orderId = await idOf(order);
    try {
      await reconcileRefunds(db, { log: quiet });
    } finally {
      pp.onStatus = null;
    }
    assert.deepEqual(await states(order), [['paid', 'requested']]);
  });

  it('records a refund the gateway accepts even when the request had been given up on', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    const orderId = await idOf(order);
    pp.onRefund = () => db.query(`UPDATE payments SET refund_state = 'failed' WHERE order_id = $1`, [orderId]);
    try {
      assert.equal((await refund(ph, order)).body.data.payment_status, 'refunded');
    } finally {
      pp.onRefund = null;
    }
    assert.deepEqual(await states(order), [['refunded', 'pending']]);
  });

  it('does not call an answer that says nothing a refund', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    pp.refundState = 'SOMETHING_ELSE';
    pp.refundPlan = { taken: false };
    try {
      const r = await refund(ph, order);
      assert.deepEqual([r.status, r.body.error.code], [502, 'REFUND_UNCONFIRMED']);
    } finally {
      pp.refundState = 'PENDING';
      pp.refundPlan = null;
    }
    assert.deepEqual(await states(order), [['paid', 'requested']]);
  });

  it('puts a refund that stays unconfirmed on the list of money to sort out', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    await refundWith({ answer: 500, taken: false, statusDown: true }, order);
    const listed = async () => (await api('GET', '/api/admin/orders/attention', { token: ph.token })).body.data.some((a) => a.kind === 'refund_unconfirmed' && a.order_number === order.number);
    assert.equal(await listed(), false, 'not at once');
    await ageRequest(order, 16);
    assert.equal(await listed(), true);
  });

  it('leaves nothing on record when the gateway refuses outright', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    const r = await refundWith({ answer: 400, taken: false }, order);
    assert.deepEqual([r.status, r.body.error.code], [502, 'PHONEPE_ERROR']);
    assert.deepEqual(await states(order), [['paid', null]]);
    assert.equal((await db.query(`SELECT 1 FROM audit_events WHERE event = 'payment.refund_refused' AND order_id = $1`, [await idOf(order)])).rowCount, 1);
  });

  it('keeps the database free while the gateway is being asked for a refund', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    let free = false;
    // An in-memory database runs one transaction at a time: a query only gets through when none is open.
    pp.onRefund = async () => {
      free = await Promise.race([db.query('SELECT 1').then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]);
    };
    try {
      assert.equal((await refund(ph, order)).status, 200);
    } finally {
      pp.onRefund = null;
    }
    assert.equal(free, true);
  });

  it('asks about a page older than three hours before opening another, and closes it only when the gateway says so', async () => {
    const aged = (order) => db.query(`UPDATE payments SET created_at = now() - interval '4 hours' WHERE order_id = $1`, [order]);
    const paidLate = await place(ph);
    await openPage(paidLate);
    await aged(await idOf(paidLate));
    pp.orders.get((await rows(paidLate))[0].provider_order_id).state = 'COMPLETED';
    assert.equal((await openPage(paidLate)).body.error.code, 'ALREADY_PAID');
    assert.equal((await view(paidLate)).payment_status, 'paid');

    const open = await place(ph);
    await openPage(open);
    await aged(await idOf(open));
    await openPage(open);
    assert.deepEqual((await rows(open)).map((p) => p.status), ['created', 'created'], 'still pending at PhonePe: kept');
    pp.orders.get((await rows(open))[0].provider_order_id).state = 'FAILED';
    await openPage(open);
    assert.deepEqual((await rows(open)).map((p) => p.status), ['failed', 'created', 'created']);
  });

  it('keeps places in each pass for paid orders, however many unpaid pages are waiting', async () => {
    await db.query(`UPDATE payments SET status = 'failed' WHERE status = 'created'`);
    const twice = await place(ph);
    await openPage(twice);
    assert.equal((await api('POST', `/api/admin/orders/${await idOf(twice)}/cash-payment`, { token: ph.token })).status, 200);
    pp.orders.get((await rows(twice))[0].provider_order_id).state = 'COMPLETED';
    const waiting = await place(ph);
    await db.query(
      `INSERT INTO payments (order_id, provider, provider_order_id, amount_paise, status) SELECT $1, 'phonepe', 'mz_waiting_' || n, 4000, 'created' FROM generate_series(1, 80) AS n`,
      [await idOf(waiting)],
    );
    for (const o of [twice, waiting]) await age(o);
    assert.equal((await reconcileOnce(db, { log: quiet })).checked, 50);
    assert.deepEqual((await rows(twice)).map((p) => [p.provider, p.status, p.is_extra]), [['phonepe', 'paid', true], ['cash', 'paid', false]]);
    await db.query(`UPDATE payments SET status = 'failed' WHERE status = 'created'`);
  });

  it('changes nothing when PhonePe says a refund failed', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    pp.refundState = 'FAILED';
    const r = await refund(ph, order);
    pp.refundState = 'PENDING';
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'REFUND_FAILED');
    assert.equal((await view(order)).payment_status, 'paid');
    assert.deepEqual((await rows(order)).map((p) => [p.status, p.refund_state]), [['paid', null]]);
    assert.equal((await db.query(`SELECT 1 FROM audit_events WHERE event = 'payment.refund_refused' AND order_id = $1`, [await idOf(order)])).rowCount, 1);
  });

  it('shows a refund as pending until the gateway finishes it', async () => {
    const order = await place(ph);
    await paidByPhonePe(order);
    assert.equal((await refund(ph, order)).body.data.refund_state, 'pending');
    assert.deepEqual([(await view(order)).payment_status, (await view(order)).refund_pending], ['refunded', true]);
    await ageRefunds();
    const [attempt] = await rows(order);
    pp.refunds.set(attempt.refund_ref, 'COMPLETED');
    await reconcileRefunds(db, { log: quiet });
    assert.equal((await adminView(ph, order)).refund_state, 'processed');
    assert.equal((await view(order)).refund_pending, false);
    assert.deepEqual((await events(order)).map((e) => e.event), ['payment.paid', 'payment.refund', 'payment.refund_processed']);
  });

  it('counts the payment as paid again when the gateway later reports that the refund failed, and lets staff retry', async () => {
    const order = await place(ph);
    const attempt = await paidByPhonePe(order);
    assert.equal((await refund(ph, order)).status, 200);
    const [row] = await rows(order);
    pp.refunds.set(row.refund_ref, 'FAILED');
    await ageRefunds();
    await reconcileRefunds(db, { log: quiet });
    const seen = await adminView(ph, order);
    assert.deepEqual([seen.payment_status, seen.refund_state], ['paid', 'failed']);
    const flagged = (await api('GET', '/api/admin/orders/attention', { token: ph.token })).body.data;
    // The kitchen had not served it, so the refund cancelled the order: it is flagged as money held for a cancelled order.
    assert.ok(flagged.some((f) => f.order_id === seen.id && f.kind === 'cancelled_paid'));
    // A repeated payment notice changes nothing, and the order can be refunded again.
    pp.orders.get(attempt.provider_order_id).state = 'COMPLETED';
    await reconcileOnce(db, { log: quiet });
    assert.deepEqual((await rows(order)).map((p) => p.status), ['paid']);
    assert.equal((await refund(ph, order)).body.data.refund_state, 'pending');
  });

  it('gives every open payment its turn in the re-check, however many unfinished ones are ahead', async () => {
    await db.query(`UPDATE payments SET status = 'failed' WHERE status = 'created'`);
    for (let i = 0; i < 60; i += 1) {
      const o = await place(ph);
      await openPage(o);
    }
    const victim = await place(rz);
    await api('POST', `/api/public/orders/${victim.token}/razorpay-qr`).then((r) => qrCodes.get(r.body.data.qr_id).payments.push({ id: 'pay_QUEUE00001', status: 'captured', amount: 4000 }));
    await db.query(`UPDATE payments SET created_at = now() - interval '10 minutes' WHERE status = 'created'`);
    await reconcileOnce(db, { log: quiet });
    await reconcileOnce(db, { log: quiet });
    assert.equal((await view(victim)).payment_status, 'paid', 'reached by the second pass');
    pp.asked.length = 0;
    await reconcileOnce(db, { log: quiet });
    await reconcileOnce(db, { log: quiet });
    assert.equal(new Set(pp.asked).size, 60, 'and every unfinished one keeps being asked about in turn');
  });

  it('stops asking about a page the gateway calls failed, an hour after it was opened', async () => {
    await db.query(`UPDATE payments SET status = 'failed' WHERE status = 'created'`);
    const order = await place(ph);
    await openPage(order);
    const [attempt] = await rows(order);
    pp.orders.get(attempt.provider_order_id).state = 'FAILED';
    await age(order);
    await reconcileOnce(db, { log: quiet });
    assert.equal((await rows(order))[0].status, 'created', 'still young');
    await db.query(`UPDATE payments SET created_at = now() - interval '2 hours' WHERE id = $1`, [attempt.id]);
    await reconcileOnce(db, { log: quiet });
    assert.equal((await rows(order))[0].status, 'failed');
    // Should the money turn out to have arrived after all, the gateway's notice still counts it.
    pp.orders.get(attempt.provider_order_id).state = 'COMPLETED';
    const key = (await db.query(`SELECT webhook_key FROM vendor_payment_settings WHERE vendor_id = $1`, [ph.vendorId])).rows[0].webhook_key;
    await api('PUT', '/api/admin/payment-settings', { token: ph.token, body: { phonepe_webhook_username: 'late-user', phonepe_webhook_password: 'late-password-1' } });
    const auth = createHash('sha256').update('late-user:late-password-1').digest('hex');
    await api('POST', `/api/webhooks/phonepe/${key}`, { body: { event: 'checkout.order.completed', payload: { merchantOrderId: attempt.provider_order_id } }, headers: { Authorization: auth } });
    assert.equal((await view(order)).payment_status, 'paid', 'a delayed notice is honoured');
  });

  it('asks the gateway before taking cash, and refuses when the diner has just paid online', async () => {
    const order = await place(ph);
    await openPage(order);
    const [attempt] = await rows(order);
    pp.orders.get(attempt.provider_order_id).state = 'COMPLETED'; // paid, but nothing has told us yet
    const r = await api('POST', `/api/admin/orders/${await idOf(order)}/cash-payment`, { token: ph.token });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /paid online/);
    assert.deepEqual([(await view(order)).payment_status, (await view(order)).payment_method], ['paid', 'phonepe']);
    assert.deepEqual((await rows(order)).map((p) => p.provider), ['phonepe']);

    const next = await place(ph);
    await openPage(next);
    pp.orders.get((await rows(next))[0].provider_order_id).state = 'COMPLETED';
    const bill = await api('POST', `/api/admin/tables/${ph.tableId}/settle`, { token: ph.token, body: { method: 'cash' } });
    assert.equal(bill.status, 409);
    assert.equal(bill.body.error.code, 'PAID_ONLINE');
  });

  it('records who took cash, and closes the order QR code so nobody can pay it again', async () => {
    const order = await place(rz);
    const qr = (await api('POST', `/api/public/orders/${order.token}/razorpay-qr`)).body.data;
    assert.equal((await api('POST', `/api/admin/orders/${await idOf(order)}/cash-payment`, { token: rz.token })).status, 200);
    assert.equal(qrCodes.get(qr.qr_id).status, 'closed');
    const cash = (await rows(order)).find((p) => p.provider === 'cash');
    assert.equal(cash.recorded_by, 'state.razorpay@example.test');
    assert.deepEqual((await events(order)).map((e) => [e.event, e.actor]), [['payment.cash', 'state.razorpay@example.test']]);
  });

  it('counts one payment once when the page, the webhook and the re-check all report it at the same moment', async () => {
    const order = await place(ph);
    await openPage(order);
    const [attempt] = await rows(order);
    pp.orders.get(attempt.provider_order_id).state = 'COMPLETED';
    await age(order);
    await Promise.all([ppVerify(order), ppVerify(order), ppVerify(order), reconcileOnce(db, { log: quiet })]);
    assert.deepEqual((await rows(order)).map((p) => [p.status, p.is_extra]), [['paid', false]]);
    assert.deepEqual((await events(order)).map((e) => e.event), ['payment.paid']);
  });

  it('keeps a paid, refunded or half-paid order from being deleted', async () => {
    const del = async (r, order) => api('DELETE', `/api/admin/orders/${await idOf(order)}`, { token: r.token });
    const paid = await place(ph);
    await paidByPhonePe(paid);
    assert.equal((await del(ph, paid)).body.error.code, 'ORDER_HAS_PAYMENTS');
    await refund(ph, paid);
    assert.equal((await del(ph, paid)).status, 409);
    const open = await place(ph);
    await openPage(open);
    assert.equal((await del(ph, open)).status, 409, 'a payment page is open');
    const plain = await place(ph);
    assert.equal((await del(ph, plain)).status, 204);
    assert.equal((await db.query(`SELECT 1 FROM audit_events WHERE event = 'order.deleted'`)).rowCount >= 1, true);
  });
});

describe('account protection: locks, password rules, sign-out, two-step sign-in', () => {
  const PASSWORD = 'a-long-enough-password';
  const OWNER = 'security.owner@mezmitra.test';
  let guarded; // the app with the limits on
  const at = () => `http://127.0.0.1:${guarded.address().port}`;
  const login = (body, headers = {}) =>
    fetch(`${at()}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const make = async (email, password = PASSWORD) => (await signupAccount({ name: 'Secure Cafe', email, password })).body.data;
  let ownerToken;

  before(async () => {
    guarded = await listen(createApp({ db, mailer: fakeMailer }));
    config.superAdminEmails.add(OWNER);
    ownerToken = (await make(OWNER)).token;
  });
  after(async () => {
    config.superAdminEmails.delete(OWNER);
    config.clientIpHeader = '';
    await db.query(`DELETE FROM rate_limits`);
    await new Promise((r) => guarded.close(r));
  });

  it('locks one account after ten wrong tries, even for the right password, and leaves others alone', async () => {
    await db.query(`DELETE FROM rate_limits`);
    await make('lock.me@example.test');
    await make('other.one@example.test');
    for (let i = 0; i < 10; i += 1) assert.equal((await login({ email: 'lock.me@example.test', password: 'wrong-guess-1' })).status, 401);
    const locked = await login({ email: 'lock.me@example.test', password: PASSWORD });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
    assert.equal((await login({ email: 'other.one@example.test', password: PASSWORD })).status, 200);
    await db.query(`UPDATE rate_limits SET reset_at = now() - interval '1 second'`);
    assert.equal((await login({ email: 'lock.me@example.test', password: PASSWORD })).status, 200, 'open again after the window');
    const { rows } = await db.query(`SELECT event, detail FROM audit_events WHERE actor = 'lock.me@example.test'`);
    assert.ok(rows.some((r) => r.event === 'auth.login_failed') && rows.some((r) => r.event === 'auth.locked'));
    assert.ok(!JSON.stringify(rows).includes('wrong-guess-1'), 'no password in the record');
  });

  it('stops guessing spread over many addresses, and still lets the owner in from another one', async () => {
    await db.query(`DELETE FROM rate_limits`);
    await make('spread.out@example.test');
    config.clientIpHeader = 'cf-connecting-ip';
    const from = (ip, password = 'wrong-guess-1') => login({ email: 'spread.out@example.test', password }, { 'CF-Connecting-IP': ip }).then((r) => r.status);
    try {
      for (let i = 0; i < 50; i += 1) assert.equal(await from(`198.51.100.${(i % 25) + 1}`), 401);
      for (let i = 0; i < 3; i += 1) assert.equal(await from('203.0.113.50'), 401);
      assert.equal(await from('203.0.113.50'), 429, 'a new address gets three tries, no more');
      assert.equal(await from('203.0.113.50', PASSWORD), 429);
      assert.equal(await from('203.0.113.200', PASSWORD), 200, 'the right password from elsewhere still works');
    } finally {
      config.clientIpHeader = '';
    }
  });

  it('does not let a few addresses lock an account for everyone', async () => {
    await db.query(`DELETE FROM rate_limits`);
    await make('not.shut.out@example.test');
    config.clientIpHeader = 'cf-connecting-ip';
    const from = (ip, password = 'wrong-guess-1') => login({ email: 'not.shut.out@example.test', password }, { 'CF-Connecting-IP': ip }).then((r) => r.status);
    try {
      for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) for (let i = 0; i < 20; i += 1) await from(ip);
      for (let i = 0; i < 4; i += 1) assert.equal(await from('203.0.113.9'), 401, 'tries from locked addresses are not counted against the account');
      assert.equal(await from('203.0.113.9', PASSWORD), 200);
    } finally {
      config.clientIpHeader = '';
    }
  });

  it('opens a locked sign-in again once a new password is set', async () => {
    await db.query(`DELETE FROM rate_limits`);
    const email = 'locked.then.reset@example.test';
    const user = await make(email);
    for (let i = 0; i < 11; i += 1) await login({ email, password: 'wrong-guess-1' });
    assert.equal((await login({ email, password: PASSWORD })).status, 429);
    sentMail.length = 0;
    await api('POST', '/api/auth/forgot-password', { body: { email } });
    const token = sentMail[0].text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    assert.equal((await api('POST', '/api/auth/reset-password', { body: { token, password: 'a-fresh-long-password' } })).status, 200);
    await db.query(`DELETE FROM rate_limits WHERE key LIKE 'login:%'`);
    assert.equal((await login({ email, password: 'a-fresh-long-password' })).status, 200);

    for (let i = 0; i < 11; i += 1) await login({ email, password: 'wrong-guess-1' });
    assert.equal((await api('POST', `/api/platform/restaurants/${user.vendor.id}/password`, { token: ownerToken, body: { password: 'set-by-the-owner-today' } })).status, 200);
    await db.query(`DELETE FROM rate_limits WHERE key LIKE 'login:%'`);
    assert.equal((await login({ email, password: 'set-by-the-owner-today' })).status, 200);
  });

  it('limits how often a signed-in session may try the password, whatever address it uses', async () => {
    await db.query(`DELETE FROM rate_limits`);
    const user = await make('stolen.session@example.test');
    config.clientIpHeader = 'cf-connecting-ip';
    try {
      const tryChange = (i) =>
        fetch(`${at()}/api/auth/change-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}`, 'CF-Connecting-IP': `198.51.100.${i}` },
          body: JSON.stringify({ current_password: 'a-guess-at-it', new_password: 'another-long-password' }),
        }).then(async (r) => (await r.json()).error.code);
      for (let i = 1; i <= 10; i += 1) assert.equal(await tryChange(i), 'WRONG_PASSWORD');
      assert.equal(await tryChange(11), 'ACCOUNT_LOCKED');
    } finally {
      config.clientIpHeader = '';
    }
  });

  it('never takes a password with a hidden second copy of itself', async () => {
    await db.query(`DELETE FROM rate_limits`);
    await make('nul.byte@example.test');
    assert.equal((await login({ email: 'nul.byte@example.test', password: `${PASSWORD}\u0000${PASSWORD}` })).status, 401);
    const { passwordProblem } = await import('../src/lib/passwords.js');
    assert.ok(passwordProblem('tableseva-demo-123\u0000tableseva-demo-123'));
  });

  it('gives no session to a password changed while it was being checked', async () => {
    await db.query(`DELETE FROM rate_limits`);
    await make('change.race@example.test');
    const newer = await (await import('bcryptjs')).default.hash('changed-in-the-meantime', 4);
    const real = db.query;
    db.query = async (sql, params) => {
      if (/SELECT id FROM vendors WHERE id = \$1 AND password_hash = \$2/.test(sql)) await real(`UPDATE vendors SET password_hash = $1 WHERE email = 'change.race@example.test'`, [newer]);
      return real(sql, params);
    };
    try {
      assert.equal((await login({ email: 'change.race@example.test', password: PASSWORD })).status, 401);
    } finally {
      db.query = real;
    }
  });

  it('limits wrong two-step codes for the whole account, whatever address they come from', async () => {
    await db.query(`DELETE FROM rate_limits`);
    const email = 'codes.cap@example.test';
    const user = await make(email);
    const { totpCode, stepAt } = await import('../src/lib/totp.js');
    const setup = (await api('POST', '/api/auth/2fa/setup', { token: user.token, body: { password: PASSWORD } })).body.data;
    const enabled = (await api('POST', '/api/auth/2fa/enable', { token: user.token, body: { code: totpCode(setup.secret, stepAt() - 1) } })).body.data;
    config.clientIpHeader = 'cf-connecting-ip';
    const from = (ip, otp) => login({ email, password: PASSWORD, otp }, { 'CF-Connecting-IP': ip });
    try {
      for (let i = 1; i <= 10; i += 1) assert.equal((await from(`198.51.100.${i}`, 'AAAAA-AAAAA')).body.error.code, 'OTP_WRONG');
      assert.equal((await from('203.0.113.9', enabled.recovery_codes[0])).body.error.code, 'ACCOUNT_LOCKED');
      sentMail.length = 0;
      await api('POST', '/api/auth/forgot-password', { body: { email } });
      await api('POST', '/api/auth/reset-password', { body: { token: sentMail[0].text.match(/#token=([A-Za-z0-9_-]+)/)[1], password: 'a-fresh-long-password' } });
      await db.query(`DELETE FROM rate_limits WHERE key LIKE 'login:%'`);
      assert.equal((await login({ email, password: 'a-fresh-long-password', otp: enabled.recovery_codes[0] }, { 'CF-Connecting-IP': '203.0.113.9' })).status, 200);
    } finally {
      config.clientIpHeader = '';
    }
  });

  it('lets recovery codes in when the authenticator secret cannot be read', async () => {
    await db.query(`DELETE FROM rate_limits`);
    const email = 'other.secret@example.test';
    const user = await make(email);
    const { totpCode, stepAt } = await import('../src/lib/totp.js');
    const setup = (await api('POST', '/api/auth/2fa/setup', { token: user.token, body: { password: PASSWORD } })).body.data;
    const enabled = (await api('POST', '/api/auth/2fa/enable', { token: user.token, body: { code: totpCode(setup.secret, stepAt() - 1) } })).body.data;
    // As if APP_SECRET had been changed since.
    await db.query(`UPDATE vendors SET totp_secret_enc = 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA' WHERE email = $1`, [email]);
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await login({ email, password: PASSWORD, otp: totpCode(setup.secret) })).body.error.code, 'OTP_WRONG');
      assert.equal((await login({ email, password: PASSWORD, otp: enabled.recovery_codes[0] })).status, 200);
    } finally {
      console.warn = warn;
    }
  });

  it('does not let a stolen session use up the password tries of the person it was stolen from', async () => {
    await db.query(`DELETE FROM rate_limits`);
    const email = 'two.sessions@example.test';
    await make(email);
    const sessions = [];
    for (let i = 0; i < 2; i += 1) sessions.push((await login({ email, password: PASSWORD })).body.data.token);
    const change = (token, current_password) =>
      fetch(`${at()}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ current_password, new_password: 'the-owner-takes-it-back' }),
      }).then((r) => r.status);
    for (let i = 0; i < 11; i += 1) await change(sessions[0], 'a-guess-at-it');
    assert.equal(await change(sessions[0], PASSWORD), 429);
    assert.equal(await change(sessions[1], PASSWORD), 200);
  });

  it('does not let a sign-in that is upgrading a hash undo a password changed in the same moment', async () => {
    await db.query(`DELETE FROM rate_limits`);
    await make('rehash.race@example.test');
    const bcrypt = (await import('bcryptjs')).default;
    const newer = await bcrypt.hash('changed-in-the-meantime', 4);
    const real = db.query;
    db.query = async (sql, params) => {
      if (/SET password_hash = \$2 WHERE id = \$1 AND password_hash/.test(sql)) await real(`UPDATE vendors SET password_hash = $1 WHERE email = 'rehash.race@example.test'`, [newer]);
      return real(sql, params);
    };
    config.bcryptCost = 5;
    try {
      assert.equal((await login({ email: 'rehash.race@example.test', password: PASSWORD })).status, 401, 'no session for the old password');
    } finally {
      db.query = real;
      config.bcryptCost = 4;
    }
    assert.equal((await db.query(`SELECT password_hash FROM vendors WHERE email = 'rehash.race@example.test'`)).rows[0].password_hash, newer);
  });

  it('a successful sign-in clears the count of wrong tries from that address', async () => {
    await db.query(`DELETE FROM rate_limits`);
    await make('forgiving@example.test');
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 6; i += 1) await login({ email: 'forgiving@example.test', password: 'wrong-guess-1' });
      assert.equal((await login({ email: 'forgiving@example.test', password: PASSWORD })).status, 200);
      await db.query(`DELETE FROM rate_limits WHERE key LIKE 'login:%'`);
    }
  });

  it('refuses passwords anyone would try, everywhere a password is chosen', async () => {
    const { passwordProblem } = await import('../src/lib/passwords.js');
    for (const bad of ['12345678', 'password123', 'qwertyuiop', 'abcdefgh', 'aaaaaaaaaa', 'teapost@123', 'Admin2024', 'tableseva-demo-123', 'teapost-demo-123', 'x'.repeat(73), '99887766554']) assert.ok(passwordProblem(bad), bad);
    assert.ok(passwordProblem('my-rameshbhai-key', { email: 'rameshbhai@example.test' }));
    for (const good of ['a-long-enough-password', 'chai & bun maska 42', 'T7#kolm-river', 'new-password-123']) assert.equal(passwordProblem(good), null, good);

    const user = await make('choosy@example.test');
    const create = await api('POST', '/api/platform/restaurants', { token: ownerToken, body: { name: 'Weak Cafe', email: 'weak.cafe@example.test', password: '12345678' } });
    assert.equal(create.status, 400);
    assert.equal(create.body.error.details[0].field, 'password');
    assert.equal((await api('POST', `/api/platform/restaurants/${user.vendor.id}/password`, { token: ownerToken, body: { password: 'password123' } })).status, 400);
    const change = await api('POST', '/api/auth/change-password', { token: user.token, body: { current_password: PASSWORD, new_password: 'qwertyuiop' } });
    assert.equal(change.body.error.details[0].field, 'new_password');
    assert.equal((await api('PUT', '/api/admin/kitchen-login', { token: user.token, body: { email: 'k.choosy@example.test', password: '11111111' } })).status, 400);
  });

  it('refuses the published demo passwords on the live server', async () => {
    await createRestaurantAccount(db, { name: 'Old Demo', email: 'old.demo@example.test', password: PASSWORD });
    const bcrypt = (await import('bcryptjs')).default;
    await db.query(`UPDATE vendors SET password_hash = $1 WHERE email = 'old.demo@example.test'`, [await bcrypt.hash('teapost-demo-123', 4)]);
    assert.equal((await login({ email: 'old.demo@example.test', password: 'teapost-demo-123' })).status, 200, 'a local run still allows it');
    config.refusePublicPasswords = true;
    try {
      const r = await login({ email: 'old.demo@example.test', password: 'teapost-demo-123' });
      assert.equal(r.status, 403);
      assert.match(r.body.error.message, /public source code/);
      assert.equal(r.body.data, undefined);
    } finally {
      config.refusePublicPasswords = false;
    }
  });

  it('refuses to put demo accounts with public passwords into a real database', async () => {
    const { seed } = await import('../src/seed.js');
    let wrote = 0;
    const database = (found) => ({ kind: 'pg', query: async () => ({ rowCount: found, rows: found ? [{ id: 1 }] : [] }), tx: async () => (wrote += 1) });
    await assert.rejects(seed(database(0), { log: () => {} }), /Refusing to seed/);
    // The accounts are there already: nothing is created, and a server with SEED_DEMO still starts.
    assert.equal(await seed(database(1), { log: () => {} }), false);
    assert.equal(wrote, 0);
  });

  it('upgrades an older password hash at the next sign-in', async () => {
    await make('old.hash@example.test');
    const rounds = async () => (await import('bcryptjs')).default.getRounds((await db.query(`SELECT password_hash FROM vendors WHERE email = 'old.hash@example.test'`)).rows[0].password_hash);
    assert.equal(await rounds(), 4);
    config.bcryptCost = 5;
    try {
      assert.equal((await login({ email: 'old.hash@example.test', password: PASSWORD })).status, 200);
      assert.equal(await rounds(), 5);
      assert.equal((await login({ email: 'old.hash@example.test', password: PASSWORD })).status, 200);
    } finally {
      config.bcryptCost = 4;
    }
  });

  it('signing out ends that session on the server, and only that one', async () => {
    await make('leaver@example.test');
    const first = (await api('POST', '/api/auth/login', { body: { email: 'leaver@example.test', password: PASSWORD } })).body.data.token;
    const second = (await api('POST', '/api/auth/login', { body: { email: 'leaver@example.test', password: PASSWORD } })).body.data.token;
    assert.equal((await api('POST', '/api/auth/logout', { token: first })).status, 200);
    for (const path of ['/api/auth/me', '/api/admin/orders', '/api/admin/payment-settings']) assert.equal((await api('GET', path, { token: first })).status, 401, path);
    assert.equal((await api('GET', '/api/auth/me', { token: second })).status, 200);
    assert.equal((await api('POST', '/api/auth/logout')).status, 401);
  });

  it('makes the same codes as an authenticator app', async () => {
    const { base32Encode, totpCode } = await import('../src/lib/totp.js');
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    // RFC 6238, SHA-1, the last six digits of its test values.
    assert.equal(totpCode(secret, Math.floor(59 / 30)), '287082');
    assert.equal(totpCode(secret, Math.floor(1111111109 / 30)), '081804');
    assert.equal(totpCode(secret, Math.floor(2000000000 / 30)), '279037');
  });

  it('asks for the app code after the password once two-step sign-in is on', async () => {
    const { stepAt, totpCode } = await import('../src/lib/totp.js');
    const email = 'two.step@example.test';
    const user = await make(email);
    const go = (path, body) => api('POST', `/api/auth/2fa/${path}`, { token: user.token, body });
    assert.equal((await go('setup', { password: 'not-my-password' })).body.error.code, 'WRONG_PASSWORD');
    const setup = (await go('setup', { password: PASSWORD })).body.data;
    assert.match(setup.otpauth_url, /^otpauth:\/\/totp\/MezMitra%3Atwo\.step%40example\.test\?secret=/);
    assert.match(setup.qr, /^data:image\/png;base64,/);
    const stored = (await db.query(`SELECT totp_secret_enc FROM vendors WHERE email = $1`, [email])).rows[0].totp_secret_enc;
    assert.ok(!stored.includes(setup.secret), 'the secret is stored encrypted');
    assert.equal((await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).status, 200, 'nothing changes until a code is confirmed');
    assert.equal((await go('enable', { code: '000000' })).body.error.code, 'OTP_WRONG');
    const enabled = (await go('enable', { code: totpCode(setup.secret, stepAt() - 1) })).body.data;
    assert.equal(enabled.recovery_codes.length, 8);

    const signIn = (otp) => api('POST', '/api/auth/login', { body: { email, password: PASSWORD, ...(otp ? { otp } : {}) } });
    const asked = await signIn();
    assert.equal(asked.status, 400);
    assert.equal(asked.body.error.code, 'OTP_REQUIRED');
    assert.equal(asked.body.data, undefined);
    assert.equal((await api('POST', '/api/auth/login', { body: { email, password: 'wrong-password-9' } })).status, 401, 'the code never replaces the password');
    assert.equal((await signIn('000000')).body.error.code, 'OTP_WRONG');
    const code = totpCode(setup.secret, stepAt());
    assert.equal((await signIn(code)).status, 200);
    assert.equal((await signIn(code)).status, 400, 'a code works once');
    assert.equal((await signIn(enabled.recovery_codes[0].toLowerCase())).status, 200);
    assert.equal((await signIn(enabled.recovery_codes[0])).status, 400, 'a recovery code works once');
    assert.equal((await api('GET', '/api/auth/2fa', { token: user.token })).body.data.recovery_codes_left, 7);

    assert.equal((await go('disable', { password: PASSWORD, code: '000000' })).status, 400);
    assert.equal((await go('disable', { password: PASSWORD, code: enabled.recovery_codes[1] })).status, 200);
    assert.equal((await signIn()).status, 200);
  });

  it('is not for the kitchen login, and a new password from the owner switches it off', async () => {
    const { stepAt, totpCode } = await import('../src/lib/totp.js');
    const user = await make('lost.phone@example.test');
    await api('PUT', '/api/admin/kitchen-login', { token: user.token, body: { email: 'k.lost@example.test', password: PASSWORD } });
    const kitchen = (await api('POST', '/api/auth/login', { body: { email: 'k.lost@example.test', password: PASSWORD } })).body.data.token;
    assert.equal((await api('POST', '/api/auth/2fa/setup', { token: kitchen, body: { password: PASSWORD } })).status, 403);
    const setup = (await api('POST', '/api/auth/2fa/setup', { token: user.token, body: { password: PASSWORD } })).body.data;
    await api('POST', '/api/auth/2fa/enable', { token: user.token, body: { code: totpCode(setup.secret, stepAt()) } });
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'k.lost@example.test', password: PASSWORD } })).status, 200, 'the kitchen signs in as before');
    assert.equal((await api('POST', `/api/platform/restaurants/${user.vendor.id}/password`, { token: ownerToken, body: { password: 'a-fresh-password-77' } })).status, 200);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'lost.phone@example.test', password: 'a-fresh-password-77' } })).status, 200);
  });

  it('voids a reset link once the owner has changed the login email', async () => {
    const user = await make('old.address@example.test');
    await api('POST', '/api/auth/forgot-password', { body: { email: 'old.address@example.test' } });
    const token = new URLSearchParams(new URL(sentMail.at(-1).text.match(/https?:\/\/\S+/)[0]).hash.slice(1)).get('token');
    assert.equal((await api('POST', `/api/platform/restaurants/${user.vendor.id}/profile`, { token: ownerToken, body: { name: 'Secure Cafe', email: 'new.address@example.test' } })).status, 200);
    const r = await api('POST', '/api/auth/reset-password', { body: { token, password: 'a-fresh-password-88' } });
    assert.equal(r.body.error.code, 'INVALID_RESET_TOKEN');
  });

  it('does not tell a restaurant which addresses have an account', async () => {
    const user = await make('curious@example.test');
    const taken = await api('PUT', '/api/admin/kitchen-login', { token: user.token, body: { email: OWNER, password: PASSWORD } });
    const used = await api('PUT', '/api/admin/kitchen-login', { token: user.token, body: { email: 'leaver@example.test', password: PASSWORD } });
    assert.deepEqual([taken.status, taken.body.error], [used.status, used.body.error]);
  });
});

describe('abuse of ordering and payment settings', () => {
  const PASSWORD = 'a-long-enough-password';
  let guarded; // the app with the limits on
  const at = () => `http://127.0.0.1:${guarded.address().port}`;
  const post = (path, body, headers = {}) =>
    fetch(`${at()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const setup = async (email, patch) => {
    const token = (await signupAccount({ name: 'Guarded Cafe', email, password: PASSWORD })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    const itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 40 } })).body.data.id;
    const table = (await api('POST', '/api/admin/tables', { token, body: { number: 'G1', capacity: 2 } })).body.data;
    if (patch) assert.equal((await api('PATCH', '/api/admin/vendor', { token, body: patch })).status, 200);
    return { token, itemId, table, qr: table.qr_url.split('/').pop() };
  };
  const order = (r, extra = {}, headers = {}) => post(`/api/public/t/${r.qr}/orders`, { items: [{ item_id: r.itemId, quantity: 1, option_ids: [] }], ...extra }, headers);
  const wrongCode = (code) => String((Number(code) + 1) % 10_000).padStart(4, '0');
  const reset = () => db.query(`DELETE FROM rate_limits`);

  before(async () => {
    guarded = await listen(createApp({ db, mailer: fakeMailer }));
  });
  after(async () => {
    config.clientIpHeader = '';
    await reset();
    await new Promise((r) => guarded.close(r));
  });

  it('stops table code guessing after ten wrong codes, and a bad cart tells nothing about a code', async () => {
    await reset();
    const r = await setup('codes@example.test', { table_code_mode: 'required' });
    const probe = (code) => post(`/api/public/t/${r.qr}/orders`, { items: [{ item_id: 999_999, quantity: 1 }], table_code: code });
    const right = await probe(r.table.code);
    const wrong = await probe(wrongCode(r.table.code));
    assert.deepEqual([right.status, right.body.error.code], [wrong.status, wrong.body.error.code], 'the same answer for a right and a wrong code');
    await reset();
    for (let i = 0; i < 10; i += 1) assert.equal((await order(r, { table_code: wrongCode(r.table.code) })).status, 403);
    const locked = await order(r, { table_code: r.table.code });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'TABLE_CODE_LOCKED');
  });

  it('counts only wrong codes: right ones never lock a table', async () => {
    await reset();
    const r = await setup('codes.right@example.test', { table_code_mode: 'required' });
    for (let i = 0; i < 12; i += 1) assert.equal((await order(r, { table_code: r.table.code })).status, 201, `order ${i + 1}`);
    assert.equal((await db.query(`SELECT COALESCE(sum(hits), 0) AS n FROM rate_limits WHERE key LIKE 'code:%'`)).rows[0].n, 0);
  });

  it('stops guessing at one table from many addresses, also when the tries come all at once', async () => {
    await reset();
    const r = await setup('codes.many@example.test', { table_code_mode: 'required' });
    config.clientIpHeader = 'cf-connecting-ip';
    const from = (ip, code = wrongCode(r.table.code)) => order(r, { table_code: code }, { 'CF-Connecting-IP': ip });
    try {
      const tries = await Promise.all(Array.from({ length: 60 }, (_, i) => from(`198.51.100.${(i % 4) + 1}`)));
      assert.equal(tries.filter((t) => t.status === 403).length, 40);
      assert.equal(tries.filter((t) => t.status === 429).length, 20);
      for (let i = 0; i < 3; i += 1) assert.equal((await from('203.0.113.50')).status, 403);
      assert.equal((await from('203.0.113.50')).status, 429, 'a new address gets three tries, no more');
    } finally {
      config.clientIpHeader = '';
    }
  });

  it('does not let one address lock a table for the people sitting at it', async () => {
    await reset();
    const r = await setup('codes.one@example.test', { table_code_mode: 'required' });
    config.clientIpHeader = 'cf-connecting-ip';
    const from = (ip, code) => order(r, { table_code: code }, { 'CF-Connecting-IP': ip });
    try {
      for (let i = 0; i < 60; i += 1) await from('198.51.100.1', wrongCode(r.table.code));
      assert.equal((await from('203.0.113.60', r.table.code)).status, 201);
    } finally {
      config.clientIpHeader = '';
    }
  });

  it('starts a table afresh with a new code', async () => {
    await reset();
    const r = await setup('codes.new@example.test', { table_code_mode: 'required' });
    for (let i = 0; i < 11; i += 1) await order(r, { table_code: wrongCode(r.table.code) });
    assert.equal((await order(r, { table_code: r.table.code })).status, 429);
    const renewed = (await api('POST', `/api/admin/tables/${r.table.id}/code`, { token: r.token })).body.data;
    assert.equal((await order(r, { table_code: renewed.code })).status, 201);
    const picture = await api('GET', `/api/admin/tables/${r.table.id}/qr.png`, { token: r.token });
    assert.match(picture.headers.get('cache-control'), /no-store/, 'an old code is never shown from a cache');
  });

  it('lets only so many orders wait at one table', async () => {
    await reset();
    const r = await setup('flood@example.test');
    const made = [];
    for (let i = 0; i < 12; i += 1) made.push(await order(r, {}, { 'Idempotency-Key': `flood-key-${i}-0000` }));
    assert.ok(made.every((m) => m.status === 201));
    const stop = await order(r);
    assert.equal(stop.status, 409);
    assert.equal(stop.body.error.code, 'TOO_MANY_OPEN_ORDERS');
    assert.equal((await order(r, {}, { 'Idempotency-Key': 'flood-key-0-0000' })).status, 200, 'a retry of an accepted order still gets it back');
    const first = (await api('GET', '/api/admin/orders?per_page=100', { token: r.token })).body.data.at(-1);
    await api('PATCH', `/api/admin/orders/${first.id}/status`, { token: r.token, body: { status: 'accepted' } });
    assert.equal((await order(r)).status, 201, 'room again once staff deal with one');
  });

  it('gives a table a new link, so an old photo of the QR code stops working', async () => {
    const r = await setup('newlink@example.test');
    const fresh = await api('POST', `/api/admin/tables/${r.table.id}/link`, { token: r.token });
    assert.equal(fresh.status, 200);
    assert.notEqual(fresh.body.data.qr_url, r.table.qr_url);
    assert.equal((await api('GET', `/api/public/t/${r.qr}`)).status, 404);
    assert.equal((await api('GET', `/api/public/t/${fresh.body.data.qr_url.split('/').pop()}`)).status, 200);
    const other = await setup('newlink.other@example.test');
    assert.equal((await api('POST', `/api/admin/tables/${r.table.id}/link`, { token: other.token })).status, 404);
  });

  it('asks for the password before payment keys change, puts it on record and tells the restaurant', async () => {
    await reset();
    const r = await setup('keys@example.test');
    const put = (body) => api('PUT', '/api/admin/payment-settings', { token: r.token, body });
    const keys = { razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' };
    const none = await put({ ...keys, current_password: undefined });
    assert.equal(none.status, 400);
    assert.deepEqual([none.body.error.code, none.body.error.details[0].field], ['PASSWORD_REQUIRED', 'current_password']);
    assert.equal((await put({ ...keys, current_password: 'not-my-password' })).body.error.code, 'WRONG_PASSWORD');
    assert.equal((await api('GET', '/api/admin/payment-settings', { token: r.token })).body.data.razorpay_key_id, null);
    const mails = sentMail.length;
    assert.equal((await put({ ...keys, current_password: PASSWORD })).status, 200);
    assert.equal(sentMail.length, mails + 1);
    assert.match(sentMail.at(-1).subject, /payment settings changed/);
    assert.ok(!sentMail.at(-1).text.includes('secret-value-123'));
    const { rows } = await db.query(`SELECT detail FROM audit_events WHERE event = 'settings.payment_changed' AND actor = 'keys@example.test'`);
    assert.deepEqual(rows.at(-1).detail.changed, ['razorpay_key_id', 'razorpay_key_secret']);
    assert.ok(!JSON.stringify(rows).includes('secret-value-123'));
    // Switching a way of paying on or off, or saving the same key id again, needs no password.
    assert.equal((await put({ razorpay_enabled: true, razorpay_key_id: keys.razorpay_key_id, current_password: undefined })).status, 200);
    for (const body of [{ razorpay_webhook_secret: 'new-hook-secret-1' }, { phonepe_client_secret: 'another-secret-1' }, { razorpay_key_id: 'rzp_test_someoneelse1' }]) {
      assert.equal((await put({ ...body, current_password: undefined })).body.error.code, 'PASSWORD_REQUIRED', Object.keys(body)[0]);
    }
  });

  it('limits password tries on the payment form', async () => {
    await reset();
    const r = await setup('keys.guess@example.test');
    const guess = () =>
      fetch(`${at()}/api/admin/payment-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${r.token}` },
        body: JSON.stringify({ razorpay_key_secret: 'secret-value-123', current_password: 'not-my-password' }),
      }).then((res) => res.status);
    for (let i = 0; i < 10; i += 1) assert.equal(await guess(), 400);
    assert.equal(await guess(), 429);
  });

  it('opens no new payment for a suspended restaurant, on an order it already had', async () => {
    const r = await setup('shut@example.test');
    await api('PUT', '/api/admin/payment-settings', { token: r.token, body: { razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: 'secret-value-123' } });
    const placed = (await api('POST', `/api/public/t/${r.qr}/orders`, { body: { pay_pref: 'online', items: [{ item_id: r.itemId, quantity: 1, option_ids: [] }] } })).body.data;
    await db.query(`UPDATE vendors SET suspended_at = now() WHERE email = 'shut@example.test'`);
    for (const path of ['razorpay', 'razorpay-qr']) assert.equal((await api('POST', `/api/public/orders/${placed.token}/${path}`)).body.error.code, 'TABLE_UNAVAILABLE', path);
    await db.query(`UPDATE vendors SET suspended_at = NULL WHERE email = 'shut@example.test'`);
  });
});

describe('server configuration: the database, the log, local runs and the web apps\' headers', () => {
  it('refuses a live database it cannot verify, and says how to fix it', async () => {
    const { buildPgConfig } = await import('../src/db.js');
    const remote = 'postgres://user:pw@db.example.test:5432/app?sslmode=require';
    const saved = { isProd: config.isProd, ca: config.databaseCa, path: config.databaseCaPath, allow: config.allowUnverifiedDbTls };
    Object.assign(config, { isProd: true, databaseCa: '', databaseCaPath: '', allowUnverifiedDbTls: false });
    try {
      assert.throws(() => buildPgConfig(remote), /DATABASE_CA_CERT/);
      assert.throws(() => buildPgConfig('postgres://user:pw@db.example.test/app?sslmode=disable'), /DATABASE_CA_CERT/);
      config.databaseCa = '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----';
      const secure = buildPgConfig(remote);
      assert.equal(secure.ssl.rejectUnauthorized, true);
      assert.ok(secure.ssl.ca.includes('\nabc\n'));
      Object.assign(config, { databaseCa: '', allowUnverifiedDbTls: true });
      assert.equal(buildPgConfig(remote).ssl.rejectUnauthorized, false, 'the explicit emergency switch');
      config.allowUnverifiedDbTls = false;
      assert.equal(buildPgConfig('postgres://user:pw@localhost/app').ssl, false, 'a database on the same machine');
    } finally {
      Object.assign(config, { isProd: saved.isProd, databaseCa: saved.ca, databaseCaPath: saved.path, allowUnverifiedDbTls: saved.allow });
    }
  });

  it('keeps a local run away from a remote database unless that is asked for', async () => {
    const { refuseRemoteDatabase } = await import('../src/lib/guard.js');
    const remote = { databaseUrl: 'postgres://u:p@db.example.test/app', isProd: false };
    assert.throws(() => refuseRemoteDatabase(remote, {}), /remote database at db\.example\.test/);
    assert.doesNotThrow(() => refuseRemoteDatabase(remote, { ALLOW_REMOTE_DB: 'true' }));
    assert.doesNotThrow(() => refuseRemoteDatabase({ ...remote, isProd: true }, {}));
    assert.doesNotThrow(() => refuseRemoteDatabase({ databaseUrl: '', isProd: false }, {}));
    assert.doesNotThrow(() => refuseRemoteDatabase({ databaseUrl: 'postgres://u:p@127.0.0.1/app', isProd: false }, {}));
  });

  it('keeps tokens out of the error log, and calls an unstorable character the sender\'s mistake', async () => {
    const { redactUrl } = await import('../src/lib/errors.js');
    const hidden = redactUrl('/api/public/orders/1ff022bd-9e47-4dc4-803d-3eb62c2986ce/pay?token=abcDEF123&x=1 /api/webhooks/razorpay/eaab53e54d224df5b5da2e69166f4b9f');
    assert.equal(hidden, '/api/public/orders/:token/pay?token=:token&x=1 /api/webhooks/razorpay/:token');
    const token = (await signupAccount({ name: 'Nul Cafe', email: 'nul@example.test', password: 'a-long-enough-password' })).body.data.token;
    const lines = [];
    const real = console.error;
    console.error = (...a) => lines.push(a.join(' '));
    try {
      const r = await api('POST', '/api/admin/categories', { token, body: { name: 'a\u0000b' } });
      assert.equal(r.status, 400);
    } finally {
      console.error = real;
    }
    assert.deepEqual(lines, []);
  });

  it('sends a content security policy with both web apps', async () => {
    const { readFile } = await import('node:fs/promises');
    const headersOf = async (path) => {
      const doc = JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'));
      return Object.fromEntries(doc.headers.find((h) => h.source === '/(.*)').headers.map((h) => [h.key, h.value]));
    };
    const admin = await headersOf('admin/vercel.json');
    assert.match(admin['Content-Security-Policy'], /default-src 'self'; script-src 'self';/);
    assert.match(admin['Content-Security-Policy'], /connect-src 'self' https:\/\/mezmitra-api\.onrender\.com;/);
    assert.match(admin['Content-Security-Policy'], /frame-ancestors 'none'/);
    const diner = await headersOf('customer/vercel.json');
    assert.match(diner['Content-Security-Policy'], /object-src 'none'; base-uri 'self'; frame-ancestors 'none'/);
    assert.match(diner['Content-Security-Policy-Report-Only'], /script-src 'self' https:\/\/\*\.razorpay\.com;/);
    for (const h of [admin, diner, await headersOf('vercel.json')]) {
      assert.ok(h['Permissions-Policy'] && h['X-Content-Type-Options'] && h['X-Frame-Options'] && h['Referrer-Policy']);
    }
  });
});

describe('a refunded order never turns paid again, whatever arrives later', () => {
  const PASSWORD = 'a-long-enough-password';
  const RZ_SECRET = 'secret-value-123';
  const HOOK = 'late-hook-secret';
  const ppOrders = new Map();
  const quiet = { info: () => {}, warn: () => {} };
  let phonepe;
  let savedBase;

  const setup = async (email, settings) => {
    const token = (await signupAccount({ name: 'Late Cafe', email, password: PASSWORD })).body.data.token;
    const cat = (await api('POST', '/api/admin/categories', { token, body: { name: 'Tea' } })).body.data;
    const itemId = (await api('POST', '/api/admin/items', { token, body: { category_id: cat.id, name: 'Chai', price: 40 } })).body.data.id;
    const qr = (await api('POST', '/api/admin/tables', { token, body: { number: 'L1', capacity: 2 } })).body.data.qr_url.split('/').pop();
    const saved = await api('PUT', '/api/admin/payment-settings', { token, body: settings });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    return { token, itemId, qr, hookKey: saved.body.data.webhook_url_razorpay.split('/').pop() };
  };
  const place = async (r) => (await api('POST', `/api/public/t/${r.qr}/orders`, { body: { pay_pref: 'online', items: [{ item_id: r.itemId, quantity: 1, option_ids: [] }] } })).body.data;
  const idOf = async (order) => (await db.query(`SELECT id FROM orders WHERE public_token = $1`, [order.token])).rows[0].id;
  const rows = async (order) => (await db.query(`SELECT * FROM payments WHERE order_id = $1 ORDER BY id`, [await idOf(order)])).rows;
  const view = async (order) => (await api('GET', `/api/public/orders/${order.token}`)).body.data;
  const refund = async (r, order) => assert.equal((await api('POST', `/api/admin/orders/${await idOf(order)}/refund`, { token: r.token })).status, 200);
  // A served order keeps its state when refunded, so nothing but the payment status protects it.
  const serve = async (r, order) => assert.equal((await api('PATCH', `/api/admin/orders/${await idOf(order)}/status`, { token: r.token, body: { status: 'completed' } })).status, 200);

  before(async () => {
    phonepe = await new Promise((resolve) => {
      const server = http
        .createServer((req, res) => {
          let raw = '';
          req.on('data', (c) => (raw += c));
          req.on('end', () => {
            const path = req.url.split('?')[0];
            const send = (body) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(body));
            };
            if (path === '/v1/oauth/token') return send({ access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 });
            if (path === '/checkout/v2/pay') {
              const body = JSON.parse(raw);
              ppOrders.set(body.merchantOrderId, { amount: body.amount, state: 'PENDING' });
              return send({ redirectUrl: 'https://phonepe.example/pay' });
            }
            if (path === '/payments/v2/refund') return send({ refundId: 'OMR_LATE', state: 'COMPLETED' });
            const m = path.match(/^\/checkout\/v2\/order\/([^/]+)\/status$/);
            const found = m && ppOrders.get(decodeURIComponent(m[1]));
            return send(found ? { state: found.state, amount: found.amount, paymentDetails: [{ state: found.state, transactionId: `TXN_${m[1]}` }] } : {});
          });
        })
        .listen(0, '127.0.0.1', () => resolve(server));
    });
    savedBase = config.phonepeApiBase;
    config.phonepeApiBase = `http://127.0.0.1:${phonepe.address().port}`;
  });
  after(async () => {
    config.phonepeApiBase = savedBase;
    await new Promise((r) => phonepe.close(r));
  });

  it('records the money of a second PhonePe page that is reported only after the refund, without reviving the order', async () => {
    const r = await setup('late.phonepe@example.test', {
      phonepe_enabled: true,
      phonepe_client_id: 'LATEMERCHANT',
      phonepe_client_version: '1',
      phonepe_client_secret: 'phonepe-client-secret-value',
      phonepe_webhook_username: 'late-user',
      phonepe_webhook_password: 'late-password-1',
    });
    const order = await place(r);
    for (let i = 0; i < 2; i += 1) assert.equal((await api('POST', `/api/public/orders/${order.token}/pay/phonepe`)).status, 200);
    const [first, second] = await rows(order);
    ppOrders.get(first.provider_order_id).state = 'COMPLETED';
    await api('POST', `/api/public/orders/${order.token}/pay/phonepe/verify`);
    await serve(r, order);
    await refund(r, order);

    ppOrders.get(second.provider_order_id).state = 'COMPLETED';
    const auth = createHash('sha256').update('late-user:late-password-1').digest('hex');
    const hook = await api('POST', `/api/webhooks/phonepe/${r.hookKey}`, { body: { event: 'checkout.order.completed', payload: { merchantOrderId: second.provider_order_id } }, headers: { Authorization: auth } });
    assert.deepEqual([hook.body.data.paid, hook.body.data.extra], [false, true]);
    await api('POST', `/api/public/orders/${order.token}/pay/phonepe/verify`);
    await reconcileOnce(db, { log: quiet });
    const after = await view(order);
    assert.deepEqual([after.payment_status, after.status, after.second_payment], ['refunded', 'completed', true]);
    assert.ok((await api('GET', '/api/admin/orders/attention', { token: r.token })).body.data.some((a) => a.kind === 'paid_twice'));
    const again = await api('POST', `/api/public/orders/${order.token}/pay/phonepe`);
    assert.equal(again.body.error.code, 'ALREADY_REFUNDED', 'no new payment page for a refunded order');
  });

  const razorpay = (name) => setup(`${name}@example.test`, { razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: RZ_SECRET, razorpay_webhook_secret: HOOK });
  const start = async (order) => (await api('POST', `/api/public/orders/${order.token}/razorpay`)).body.data;
  const reported = (order, started, id) =>
    api('POST', `/api/public/orders/${order.token}/razorpay/verify`, {
      body: { razorpay_order_id: started.razorpay_order_id, razorpay_payment_id: id, razorpay_signature: createHmac('sha256', RZ_SECRET).update(`${started.razorpay_order_id}|${id}`).digest('hex') },
    });
  const hooked = (r, started, id, amount = started.amount_paise) => {
    const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id, order_id: started.razorpay_order_id, amount, status: 'captured' } } } });
    return api('POST', `/api/webhooks/razorpay/${r.hookKey}`, { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': createHmac('sha256', HOOK).update(raw).digest('hex') } });
  };
  const paidByRazorpay = async (order, id) => {
    const started = await start(order);
    rzpPayments.set(id, { status: 'captured', amount: started.amount_paise, order_id: started.razorpay_order_id });
    assert.equal((await reported(order, started, id)).body.data.payment_status, 'paid');
    return started;
  };

  it('records a refund made in the Razorpay dashboard when staff press Refund', async () => {
    const r = await razorpay('dashboard.refund');
    const order = await place(r);
    const started = await paidByRazorpay(order, 'pay_DASHB00001');
    rzpTaken.set('pay_DASHB00001', [{ id: 'rfnd_DASHB1', amount: started.amount_paise, status: 'processed' }]);
    rzpRefundPlans.set('pay_DASHB00001', { answer: 400, taken: false });
    await refund(r, order);
    assert.deepEqual((await rows(order)).map((p) => [p.status, p.refund_state, p.refund_id]), [['refunded', 'processed', 'rfnd_DASHB1']]);
  });

  it('takes a payment that includes the fee the diner paid, and never one that is short', async () => {
    const r = await razorpay('fee.bearer');
    const short = await place(r);
    assert.equal((await hooked(r, await start(short), 'pay_SHORT00001', 3999)).body.data.mismatch, true);
    const order = await place(r);
    assert.equal((await hooked(r, await start(order), 'pay_WITHFEE001', 4094)).body.data.paid, true);
    assert.equal((await view(order)).payment_status, 'paid');
  });

  it('keeps a second captured payment on a Razorpay order that was counted already', async () => {
    const r = await razorpay('second.capture');
    const order = await place(r);
    const started = await paidByRazorpay(order, 'pay_FIRSTCAP01');
    assert.equal((await hooked(r, started, 'pay_FIRSTCAP01')).body.data.already, true);
    assert.equal((await hooked(r, started, 'pay_SECONDCAP1')).body.data.extra, true);
    assert.equal((await hooked(r, started, 'pay_SECONDCAP1')).body.data.already, true);
    assert.deepEqual((await rows(order)).map((p) => [p.provider_payment_id, p.is_extra]), [['pay_FIRSTCAP01', false], ['pay_SECONDCAP1', true]]);
  });

  it('keeps both payments when two notices of different captures arrive together', async () => {
    const r = await razorpay('twin.captures');
    const order = await place(r);
    const started = await start(order);
    const real = db.query;
    // The other notice counts the attempt between this one's reading and writing.
    db.query = async (sql, params) => {
      if (/provider_payment_id = \$1$/.test(sql) && params[0] === 'pay_TWINSECOND') {
        db.query = real;
        await hooked(r, started, 'pay_TWINFIRST1');
      }
      return real(sql, params);
    };
    try {
      assert.equal((await hooked(r, started, 'pay_TWINSECOND')).body.data.extra, true);
    } finally {
      db.query = real;
    }
    assert.deepEqual((await rows(order)).map((p) => [p.provider_payment_id, p.is_extra]), [['pay_TWINFIRST1', false], ['pay_TWINSECOND', true]]);
  });

  it('never asks for money twice: the checkout never gets a QR id, and a paid QR is found before anything new', async () => {
    const r = await razorpay('qr.then.checkout');
    const order = await place(r);
    const qr = (await api('POST', `/api/public/orders/${order.token}/razorpay-qr`)).body.data;
    assert.match((await start(order)).razorpay_order_id, /^order_/);
    qrCodes.get(qr.qr_id).payments.push({ id: 'pay_QRUNSEEN01', status: 'captured', amount: 4000 });
    qrCodes.get(qr.qr_id).status = 'closed';
    for (const path of ['razorpay-qr', 'razorpay']) assert.equal((await api('POST', `/api/public/orders/${order.token}/${path}`)).body.error.code, 'ALREADY_PAID', path);
    assert.equal((await view(order)).payment_status, 'paid');
  });

  it('records no cash for a bill that has changed since staff opened it', async () => {
    const r = await razorpay('stale.bill');
    const one = await place(r);
    const started = await start(one);
    const two = (await api('POST', `/api/public/t/${r.qr}/orders`, { body: { items: [{ item_id: r.itemId, quantity: 1, option_ids: [] }] } })).body.data;
    const table = (await api('GET', '/api/admin/tables', { token: r.token })).body.data[0];
    const shown = (await api('GET', `/api/admin/tables/${table.id}/bill`, { token: r.token })).body.data.orders.map((o) => o.id);
    await hooked(r, started, 'pay_MIDBILL001'); // paid online while staff are looking at the bill
    const settle = (order_ids) => api('POST', `/api/admin/tables/${table.id}/settle`, { token: r.token, body: { method: 'cash', order_ids } });
    const stale = await settle(shown);
    assert.deepEqual([stale.status, stale.body.error.code], [409, 'BILL_CHANGED']);
    assert.equal((await view(two)).payment_status, 'unpaid');
    const fresh = await settle([await idOf(two)]);
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  });

  it('records no cash on a refunded order, and does not report it as waiting for money', async () => {
    const r = await razorpay('refunded.cash');
    const order = await place(r);
    await paidByRazorpay(order, 'pay_REFCASH001');
    await serve(r, order);
    await refund(r, order);
    const cash = await api('POST', `/api/admin/orders/${await idOf(order)}/cash-payment`, { token: r.token });
    assert.deepEqual([cash.status, cash.body.error.code], [409, 'ALREADY_REFUNDED']);
    assert.equal((await api('GET', '/api/admin/reports/summary', { token: r.token })).body.data.placed.unpaid, 0);
  });

  it('does the same for Razorpay: a held payment is not taken and a captured one is flagged', async () => {
    const r = await setup('late.razorpay@example.test', { razorpay_enabled: true, razorpay_key_id: 'rzp_test_abcdef123456', razorpay_key_secret: RZ_SECRET, razorpay_webhook_secret: HOOK });
    const order = await place(r);
    const start = (await api('POST', `/api/public/orders/${order.token}/razorpay`)).body.data;
    const qr = (await api('POST', `/api/public/orders/${order.token}/razorpay-qr`)).body.data;
    qrCodes.get(qr.qr_id).payments.push({ id: 'pay_LATEQR001', status: 'captured', amount: start.amount_paise });
    await api('POST', `/api/public/orders/${order.token}/razorpay-qr/verify`);
    await serve(r, order);
    await refund(r, order);

    rzpPayments.set('pay_LATEHELD01', { status: 'authorized', amount: start.amount_paise, order_id: start.razorpay_order_id });
    const signature = createHmac('sha256', RZ_SECRET).update(`${start.razorpay_order_id}|pay_LATEHELD01`).digest('hex');
    const held = await api('POST', `/api/public/orders/${order.token}/razorpay/verify`, { body: { razorpay_order_id: start.razorpay_order_id, razorpay_payment_id: 'pay_LATEHELD01', razorpay_signature: signature } });
    assert.equal(held.body.error.code, 'PAYMENT_NOT_TAKEN');
    assert.equal(razorpayCalls.filter((c) => c.url.endsWith('/payments/pay_LATEHELD01/capture')).length, 0);

    const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_LATECAP001', order_id: start.razorpay_order_id, amount: start.amount_paise, status: 'captured' } } } });
    const hook = await api('POST', `/api/webhooks/razorpay/${r.hookKey}`, { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': createHmac('sha256', HOOK).update(raw).digest('hex') } });
    assert.deepEqual([hook.body.data.paid, hook.body.data.extra], [false, true]);
    assert.equal((await view(order)).payment_status, 'refunded');
    for (const path of ['razorpay', 'razorpay-qr']) assert.equal((await api('POST', `/api/public/orders/${order.token}/${path}`)).body.error.code, 'ALREADY_REFUNDED', path);
  });
});

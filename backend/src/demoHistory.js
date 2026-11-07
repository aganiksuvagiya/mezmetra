import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { TEA_POST } from './seed.js';

// Sample order history for a demo restaurant, so the dashboard, charts, Orders list and Reports have something to show.
//   npm run demo:history                      (Tea Post: 4 paid orders over the last 2 days, enough for a demo)
//   npm run demo:history -- --orders 6        (another number of orders)
//   npm run demo:history -- --busy            (a busy cafe: ~30 orders a day for 14 days; --days 30 for longer)
//   npm run demo:history -- --email you@x.in  (another restaurant)
//   npm run demo:history -- --remove          (take the sample orders away again)
// Every generated order carries an idempotency key that starts with "demo-history-", so removing (or regenerating) only ever
// touches these and never a real order. Re-running regenerates the history relative to today.

export const MARK = 'demo-history-';
const MAX_DAYS = 60;

// Small seeded random generator (mulberry32): the same seed gives the same history.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const between = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
function weighted(rand, entries) {
  const total = entries.reduce((n, [, w]) => n + w, 0);
  let r = rand() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

// A tea cafe's day: a morning rush, a quiet afternoon, a bigger evening one.
const HOUR_WEIGHTS = [[7, 6], [8, 10], [9, 9], [10, 6], [11, 4], [12, 4], [13, 3], [14, 3], [15, 5], [16, 8], [17, 11], [18, 10], [19, 7], [20, 4], [21, 2]];
const NOTES = ['Less sugar', 'Extra hot please', 'Parcel', 'No sugar in one', 'Less milk', 'Little spicy'];

const pad = (n) => String(n).padStart(2, '0');
const addMinutes = (stamp, minutes) => {
  const d = new Date(`${stamp}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 19);
};
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Loads the restaurant's active menu with its option groups, as plain data. */
async function loadMenu(db, vendorId) {
  const items = (await db.query(`SELECT id, name, price_paise, is_featured FROM items WHERE vendor_id = $1 AND is_active ORDER BY id`, [vendorId])).rows;
  const groups = (await db.query(`SELECT g.id, g.item_id, g.name, g.multi_select, g.required FROM option_groups g JOIN items i ON i.id = g.item_id WHERE i.vendor_id = $1 ORDER BY g.sort_order, g.id`, [vendorId])).rows;
  const options = (await db.query(`SELECT o.id, o.group_id, o.name, o.price_paise FROM options o JOIN option_groups g ON g.id = o.group_id JOIN items i ON i.id = g.item_id WHERE i.vendor_id = $1 ORDER BY o.sort_order, o.id`, [vendorId])).rows;
  return items.map((item) => ({
    ...item,
    // Cheap dishes sell more, featured ones more again.
    weight: (100 / (item.price_paise / 100 + 30)) * (item.is_featured ? 2 : 1),
    groups: groups.filter((g) => g.item_id === item.id).map((g) => ({ ...g, options: options.filter((o) => o.group_id === g.id) })),
  }));
}

function buildLines(rand, menu) {
  // A small menu cannot fill a big order: never ask for more different dishes than there are.
  const count = Math.min(menu.length, weighted(rand, [[1, 5], [2, 4], [3, 1.5]]));
  const lines = [];
  const used = new Set();
  for (let i = 0; i < count; i += 1) {
    const item = weighted(rand, menu.filter((m) => !used.has(m.id)).map((m) => [m, m.weight]));
    used.add(item.id);
    const chosen = [];
    for (const group of item.groups) {
      if (group.options.length === 0) continue;
      // Mostly the first (default) choice; optional groups are picked about half of the time.
      if (group.required || rand() < 0.5) chosen.push(rand() < 0.65 ? group.options[0] : pick(rand, group.options));
    }
    const unit = item.price_paise + chosen.reduce((n, o) => n + o.price_paise, 0);
    const quantity = weighted(rand, [[1, 6], [2, 3], [3, 0.8]]);
    lines.push({
      item_id: item.id,
      name: item.name,
      unit,
      quantity,
      options: chosen.map((o) => ({ group: item.groups.find((g) => g.id === o.group_id).name, name: o.name, price_paise: o.price_paise })),
      lineTotal: unit * quantity,
    });
  }
  return lines;
}

/**
 * Replaces the restaurant's sample history. `now` is only for tests. Resolves to a summary.
 * Orders are placed in the restaurant's own time zone, only up to 45 minutes before "now" so none is half-finished.
 * With `orders: n` exactly n paid, completed orders are spread over the last `days` days; without it a busy cafe's history is made.
 */
export async function generateHistory(db, { vendorId, days = 14, orders: count = null, now = new Date() }) {
  const vendor = (await db.query(`SELECT id, name, timezone, tax_percent FROM vendors WHERE id = $1`, [vendorId])).rows[0];
  if (!vendor) throw new Error('Restaurant not found');
  const menu = await loadMenu(db, vendorId);
  const tables = (await db.query(`SELECT id, number FROM dining_tables WHERE vendor_id = $1 AND is_active ORDER BY id`, [vendorId])).rows;
  if (menu.length === 0 || tables.length === 0) throw new Error('The restaurant needs a menu and at least one table before it can get sample orders');

  const clock = (await db.query(`SELECT to_char(($2::timestamptz) AT TIME ZONE $1, 'YYYY-MM-DD"T"HH24:MI:SS') AS stamp`, [vendor.timezone, now.toISOString()])).rows[0].stamp;
  const today = clock.slice(0, 10);
  const cutoff = addMinutes(clock, -45);
  const rand = rng(Number(vendorId) * 7919 + days);
  const taxPercent = Number(vendor.tax_percent);

  // When each order was placed.
  const slots = [];
  if (count) {
    const makeTime = (day) => {
      for (let tries = 0; tries < 30; tries += 1) {
        const stamp = `${day}T${pad(weighted(rand, HOUR_WEIGHTS))}:${pad(between(rand, 0, 59))}:${pad(between(rand, 0, 59))}`;
        if (stamp <= cutoff) return stamp;
      }
      return null;
    };
    // Round and round over the last `days` days. Today counts only once the shop has "opened" (some opening hour has passed).
    const dayList = [];
    for (let back = 0; back <= days && dayList.length < days; back += 1) {
      const day = addDays(today, -back);
      if (back === 0 && !HOUR_WEIGHTS.some(([hour]) => `${day}T${pad(hour)}:00:00` <= cutoff)) continue;
      dayList.push(day);
    }
    for (let i = 0; slots.length < count && i < count * 12; i += 1) {
      const stamp = makeTime(dayList[i % dayList.length]);
      if (stamp) slots.push(stamp);
    }
  } else {
    for (let back = days; back >= 0; back -= 1) {
      const day = addDays(today, -back);
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      const volume = between(rand, 24, 38) * (weekday === 0 || weekday === 6 ? 1.3 : 1);
      for (let i = 0; i < Math.round(volume); i += 1) {
        const stamp = `${day}T${pad(weighted(rand, HOUR_WEIGHTS))}:${pad(between(rand, 0, 59))}:${pad(between(rand, 0, 59))}`;
        if (stamp <= cutoff) slots.push(stamp);
      }
    }
  }
  slots.sort();

  const orders = [];
  const usedRefs = new Set();
  for (const placed of slots) {
    const lines = buildLines(rand, menu);
    const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
    const tax = Math.round((subtotal * taxPercent) / 100);
    const cancelled = !count && rand() < 0.05;
    const accepted = addMinutes(placed, between(rand, 1, 4));
    const paid = addMinutes(accepted, between(rand, 2, 12));
    const completed = addMinutes(paid, between(rand, 1, 8));
    let ref;
    do ref = `4${String(Math.floor(rand() * 1e11)).padStart(11, '0')}`;
    while (usedRefs.has(ref));
    usedRefs.add(ref);
    orders.push({
      key: `${MARK}${orders.length + 1}`,
      table: pick(rand, tables),
      lines,
      subtotal,
      tax,
      total: subtotal + tax,
      note: rand() < 0.08 ? pick(rand, NOTES) : '',
      status: cancelled ? 'cancelled' : 'completed',
      placed,
      accepted: cancelled ? null : accepted,
      paid: cancelled ? null : paid,
      completed: cancelled ? null : completed,
      claimedAt: cancelled ? null : addMinutes(placed, between(rand, 4, 10)),
      ref: cancelled ? null : ref,
    });
  }

  const tz = vendor.timezone;
  const ts = (v) => (v ? `${v.replace('T', ' ')}` : null);
  await db.tx(async (t) => {
    await t.query(`DELETE FROM orders WHERE vendor_id = $1 AND idempotency_key LIKE $2`, [vendorId, `${MARK}%`]);
    for (let start = 0; start < orders.length; start += 60) {
      const chunk = orders.slice(start, start + 60);
      const params = [tz];
      const rows = chunk.map((o) => {
        const base = params.length;
        params.push(vendorId, o.table.id, o.table.number, o.key, o.status, o.paid ? 'paid' : 'unpaid', o.paid ? 'upi' : null, o.subtotal, o.tax, o.total, o.note, ts(o.placed), ts(o.accepted), ts(o.completed), ts(o.paid), o.ref, ts(o.claimedAt));
        const p = (i) => `$${base + i}`;
        const at = (i) => `(${p(i)}::timestamp AT TIME ZONE $1)`;
        return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, 'upi', ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${at(12)}, ${at(13)}, ${at(14)}, ${at(15)}, ${p(16)}, ${at(17)})`;
      });
      const inserted = await t.query(
        `INSERT INTO orders (vendor_id, table_id, table_number, idempotency_key, status, payment_status, payment_method, pay_pref,
                             subtotal_paise, tax_paise, total_paise, note, created_at, accepted_at, completed_at, paid_at, claim_reference, claimed_at)
         VALUES ${rows.join(', ')} RETURNING id, idempotency_key`,
        params,
      );
      const idByKey = new Map(inserted.rows.map((r) => [r.idempotency_key, r.id]));

      const itemParams = [];
      const itemRows = [];
      const payParams = [tz];
      const payRows = [];
      for (const o of chunk) {
        const orderId = idByKey.get(o.key);
        for (const l of o.lines) {
          const base = itemParams.length;
          itemParams.push(orderId, l.item_id, l.name, l.unit, l.quantity, JSON.stringify(l.options), l.lineTotal);
          itemRows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, '', $${base + 6}::jsonb, $${base + 7})`);
        }
        if (o.paid) {
          const base = payParams.length;
          payParams.push(orderId, o.ref, o.total, ts(o.paid));
          payRows.push(`($${base + 1}, 'upi', $${base + 2}, $${base + 3}, 'paid', ($${base + 4}::timestamp AT TIME ZONE $1), ($${base + 4}::timestamp AT TIME ZONE $1))`);
        }
      }
      await t.query(`INSERT INTO order_items (order_id, item_id, name, unit_price_paise, quantity, instructions, options, line_total_paise) VALUES ${itemRows.join(', ')}`, itemParams);
      if (payRows.length) {
        await t.query(`INSERT INTO payments (order_id, provider, provider_payment_id, amount_paise, status, paid_at, created_at) VALUES ${payRows.join(', ')}`, payParams);
      }
    }
  });

  const paidOrders = orders.filter((o) => o.paid);
  return {
    restaurant: vendor.name,
    days,
    orders: orders.length,
    paid: paidOrders.length,
    cancelled: orders.length - paidOrders.length,
    revenue: paidOrders.reduce((n, o) => n + o.total, 0) / 100,
  };
}

/** Removes the sample orders (and only those). Resolves to how many were removed. */
export async function removeHistory(db, { vendorId }) {
  const { rowCount } = await db.query(`DELETE FROM orders WHERE vendor_id = $1 AND idempotency_key LIKE $2`, [vendorId, `${MARK}%`]);
  return rowCount;
}

// CLI
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
  const email = String(arg('email', TEA_POST.email)).toLowerCase();
  const busy = args.includes('--busy');
  const days = Math.min(MAX_DAYS, Math.max(1, Number(arg('days', busy ? 14 : 2)) || (busy ? 14 : 2)));
  const orderCount = busy ? null : Math.min(200, Math.max(1, Number(arg('orders', 4)) || 4));
  const db = await createDb();
  try {
    await migrate(db, { log: () => {} });
    const vendor = (await db.query(`SELECT id, name FROM vendors WHERE lower(email) = $1`, [email])).rows[0];
    if (!vendor) {
      console.error(`No restaurant with the email ${email}.`);
      process.exitCode = 1;
    } else if (args.includes('--remove')) {
      console.log(`Removed ${await removeHistory(db, { vendorId: vendor.id })} sample orders from ${vendor.name}.`);
    } else {
      const r = await generateHistory(db, { vendorId: vendor.id, days, orders: orderCount });
      console.log(`${r.restaurant}: added ${r.orders} sample orders over the last ${r.days} days (${r.paid} paid by UPI, ${r.cancelled} cancelled), Rs ${r.revenue.toFixed(2)} in sales.`);
      console.log('Run the same command again to refresh the dates; add --remove to take them away.');
    }
  } finally {
    await db.close();
  }
}

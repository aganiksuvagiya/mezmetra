import { getItem, getJSON, removeItem, setItem, setJSON } from './storage';

// What this device remembers about orders:
//   mezmitra_last_order_<tableToken>  -> the latest order token for that table (drives the menu banner)
//   mezmitra_order_table_<orderToken> -> which table an order belongs to (drives "Order more" after a reload)
//   mezmitra_recent_orders            -> a short list of this diner's latest orders (drives "Your recent orders" on the menu)
// All of it stays in this browser. Nothing here is sent anywhere.

const lastKey = (tableToken) => `mezmitra_last_order_${tableToken}`;
const tableKey = (orderToken) => `mezmitra_order_table_${orderToken}`;

export function rememberOrder(tableToken, orderToken) {
  setItem(lastKey(tableToken), orderToken);
  setItem(tableKey(orderToken), tableToken);
}

export const getLastOrder = (tableToken) => getItem(lastKey(tableToken));

export const tableForOrder = (orderToken) => getItem(tableKey(orderToken));

/** Forget the "unfinished order" pointer (only if it still points at this order). */
export function forgetLastOrder(tableToken, orderToken) {
  if (!orderToken || getItem(lastKey(tableToken)) === orderToken) removeItem(lastKey(tableToken));
}

/** Done: cancelled, or completed and paid. Nothing more for the diner to follow. */
export const isFinished = (order) =>
  order.status === 'cancelled' || (order.status === 'completed' && order.payment_status === 'paid');

// ---- Recent orders: the latest few per restaurant, kept on this device -------------------------------------------------------

export const RECENT_PER_RESTAURANT = 5;
const RECENT_TOTAL = 20; // a hard ceiling, so a diner who eats everywhere never fills up the storage
const RECENT_KEY = 'mezmitra_recent_orders';

/** "1× Cutting Chai" or "2× Cutting Chai +1 more": enough to recognise the order at a glance. */
function summaryOf(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const first = `${items[0].quantity}× ${items[0].name}`;
  return items.length > 1 ? `${first} +${items.length - 1} more` : first;
}

/** The few facts the list needs, as they stand right now. */
const snapshot = (order, tableToken) => ({
  token: order.token,
  tableToken: tableToken || '',
  vendor: order.vendor?.name ?? '',
  number: order.number ?? null,
  total: Number(order.total) || 0,
  summary: summaryOf(order.items),
  status: order.status,
  ready: Boolean(order.ready_at),
  paid: order.payment_status === 'paid',
  done: isFinished(order),
  placedAt: Date.parse(order.created_at) || Date.now(),
});

const validEntry = (o) => o && typeof o === 'object' && typeof o.token === 'string' && o.token && typeof o.vendor === 'string' && Number.isFinite(o.placedAt);

/** Newest first, at most RECENT_PER_RESTAURANT per restaurant and RECENT_TOTAL overall. */
function trim(list) {
  const seen = new Map();
  const kept = [];
  for (const o of [...list].sort((a, b) => b.placedAt - a.placedAt)) {
    const n = seen.get(o.vendor) ?? 0;
    if (n >= RECENT_PER_RESTAURANT) continue;
    seen.set(o.vendor, n + 1);
    kept.push(o);
  }
  return kept.slice(0, RECENT_TOTAL);
}

const readAll = () => {
  const stored = getJSON(RECENT_KEY, []);
  return Array.isArray(stored) ? stored.filter(validEntry) : [];
};

/** This device's latest orders at one restaurant (all of them when no name is given), newest first. */
export const getRecentOrders = (vendorName) => readAll().filter((o) => !vendorName || o.vendor === vendorName);

/** Add an order to the list, or refresh what is known about it (its status moves on while the diner follows it). */
export function recordOrder(order, tableToken) {
  if (!order?.token) return;
  const all = readAll();
  const before = all.find((o) => o.token === order.token);
  setJSON(RECENT_KEY, trim([...all.filter((o) => o.token !== order.token), snapshot(order, tableToken || before?.tableToken)]));
}

/** The order no longer exists (the restaurant removed it), so it does not belong on the list either. */
export function dropRecentOrder(orderToken) {
  setJSON(RECENT_KEY, readAll().filter((o) => o.token !== orderToken));
}

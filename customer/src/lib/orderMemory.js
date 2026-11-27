import { getItem, getJSON, removeItem, setItem, setJSON } from './storage';

// What this device remembers about orders:
//   mezmitra_last_order_<tableToken>  -> the latest order token for that table (drives the menu banner)
//   mezmitra_order_table_<orderToken> -> which table an order belongs to (drives "Order more" after a reload)
//   mezmitra_recent_orders            -> a short list of this diner's latest orders (drives "Your recent orders" on the menu)
// All of it stays in this browser. Nothing here is sent anywhere.
//
// A phone can be passed on, or a table can be scanned by the next person on the same phone, so the memory is a "visit", not a diary:
// an order is listed while it is still moving, and for a short while after it is finished (to look at it once more); after that, or
// once it is simply old, the phone forgets it. A diner can also clear the list by hand.

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

/** Done: cancelled, or completed with nothing left to pay (paid, or paid and refunded). Nothing more for the diner to follow. */
export const isFinished = (order) =>
  order.status === 'cancelled' || (order.status === 'completed' && order.payment_status !== 'unpaid');

// ---- Recent orders: the latest few per restaurant, kept on this device -------------------------------------------------------

export const RECENT_PER_RESTAURANT = 5;
/** How long a finished (cancelled, or completed and paid) order stays on the list, counted from when this phone first saw it finished. */
export const FINISHED_STAYS_MS = 30 * 60_000;
/** Whatever the status, an order older than this is not part of the current visit any more (e.g. one the restaurant never closed). */
export const VISIT_MAX_MS = 12 * 60 * 60_000;
const RECENT_TOTAL = 20; // a hard ceiling, so a diner who eats everywhere never fills up the storage
const RECENT_KEY = 'mezmitra_recent_orders';

/** "1× Cutting Chai" or "2× Cutting Chai +1 more": enough to recognise the order at a glance. */
function summaryOf(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const first = `${items[0].quantity}× ${items[0].name}`;
  return items.length > 1 ? `${first} +${items.length - 1} more` : first;
}

/** When this phone first saw the order finished (kept from the earlier entry once it is known). */
const doneAtOf = (before) => (before?.done && Number.isFinite(before.doneAt) ? before.doneAt : Date.now());

/** The few facts the list needs, as they stand right now. */
const snapshot = (order, tableToken, before) => ({
  token: order.token,
  tableToken: tableToken || '',
  vendor: order.vendor?.name ?? '',
  number: order.number ?? null,
  total: Number(order.total) || 0,
  summary: summaryOf(order.items),
  status: order.status,
  ready: Boolean(order.ready_at),
  paid: order.payment_status === 'paid',
  refunded: order.payment_status === 'refunded',
  done: isFinished(order),
  // When this phone first saw it finished: the finished order stays on the list for FINISHED_STAYS_MS from then.
  doneAt: isFinished(order) ? doneAtOf(before) : undefined,
  placedAt: Date.parse(order.created_at) || Date.now(),
});

const validEntry = (o) => o && typeof o === 'object' && typeof o.token === 'string' && o.token && typeof o.vendor === 'string' && Number.isFinite(o.placedAt);

/** Still part of this visit: not too old, and (when finished) not finished long ago. An older entry saved without a doneAt counts from when it was placed. */
export function isCurrent(o, now = Date.now()) {
  if (now - o.placedAt > VISIT_MAX_MS) return false;
  return !o.done || now - (Number.isFinite(o.doneAt) ? o.doneAt : o.placedAt) < FINISHED_STAYS_MS;
}

/** Newest first, at most RECENT_PER_RESTAURANT per restaurant and RECENT_TOTAL overall. */
function trim(list) {
  const seen = new Map();
  const kept = [];
  for (const o of [...list].filter((e) => isCurrent(e)).sort((a, b) => b.placedAt - a.placedAt)) {
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

/** This device's orders of the current visit at one restaurant (all of them when no name is given), newest first. */
export const getRecentOrders = (vendorName) => readAll().filter((o) => (!vendorName || o.vendor === vendorName) && isCurrent(o));

/** Add an order to the list, or refresh what is known about it (its status moves on while the diner follows it). */
export function recordOrder(order, tableToken) {
  if (!order?.token) return;
  const all = readAll();
  const before = all.find((o) => o.token === order.token);
  setJSON(RECENT_KEY, trim([...all.filter((o) => o.token !== order.token), snapshot(order, tableToken || before?.tableToken, before)]));
}

/** The order no longer exists (the restaurant removed it), so it does not belong on the list either. */
export function dropRecentOrder(orderToken) {
  setJSON(RECENT_KEY, readAll().filter((o) => o.token !== orderToken));
  notifyOrdersChanged();
}

/**
 * The diner asked this phone to forget the orders listed at one restaurant (the restaurant keeps them). The "your order" pointers of
 * those orders go too, so the menu banner disappears with the list.
 */
export function clearRecentOrders(vendorName) {
  const all = readAll();
  const gone = all.filter((o) => !vendorName || o.vendor === vendorName);
  for (const o of gone) {
    if (o.tableToken) forgetLastOrder(o.tableToken, o.token);
    removeItem(tableKey(o.token));
  }
  const goneTokens = new Set(gone.map((o) => o.token));
  setJSON(RECENT_KEY, all.filter((o) => !goneTokens.has(o.token)));
  notifyOrdersChanged();
}

// Screens that show this memory (the list, the banner) listen so that a change made anywhere on the page shows at once.
const CHANGED = 'mezmitra:orders-changed';
function notifyOrdersChanged() {
  try {
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    /* no window (tests): nothing is listening anyway */
  }
}

/** Call `onChange` whenever the remembered orders are cleared or dropped. Returns the function that stops listening. */
export function onOrdersChanged(onChange) {
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
}

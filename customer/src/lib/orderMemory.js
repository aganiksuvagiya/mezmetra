import { getItem, removeItem, setItem } from './storage';

// What this device remembers about orders:
//   mezmitra_last_order_<tableToken>  -> the latest order token for that table (drives the menu banner)
//   mezmitra_order_table_<orderToken> -> which table an order belongs to (drives "Order more" after a reload)

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

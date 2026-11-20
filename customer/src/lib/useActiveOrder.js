import { useEffect, useState } from 'react';
import { getOrder, isAbort } from './api';
import { VISIT_MAX_MS, forgetLastOrder, getLastOrder, isFinished, onOrdersChanged, recordOrder } from './orderMemory';

// Remember the last answer per table so coming back from the cart does not make the banner pop in again.
const cache = new Map();

/**
 * The unfinished order this device placed for a table, for the "View your order" banner on the menu.
 * Returns null while unknown / when there is none; { token, order } otherwise. `order` is null when the
 * server could not be reached (we still show a generic banner because the order probably exists).
 */
export function useActiveOrder(tableToken) {
  const [active, setActive] = useState(() => {
    const hit = cache.get(tableToken);
    return hit && hit.token === getLastOrder(tableToken) ? hit : null;
  });

  useEffect(() => {
    const token = getLastOrder(tableToken);
    const update = (value) => {
      if (value) cache.set(tableToken, value);
      else cache.delete(tableToken);
      setActive(value);
    };
    if (!token) {
      update(null);
      return undefined;
    }
    const controller = new AbortController();
    getOrder(token, { signal: controller.signal })
      .then((order) => {
        // Finished, or so old that it cannot be this visit's order (one the restaurant never closed): not "your order" any more.
        if (isFinished(order) || Date.now() - Date.parse(order.created_at) > VISIT_MAX_MS) {
          forgetLastOrder(tableToken, token);
          update(null);
        } else {
          recordOrder(order, tableToken); // an order placed before the "recent orders" list existed joins it here
          update({ token, order });
        }
      })
      .catch((err) => {
        if (isAbort(err) || controller.signal.aborted) return;
        if (err.status === 404) {
          forgetLastOrder(tableToken, token);
          update(null);
        } else {
          update({ token, order: null });
        }
      });
    return () => controller.abort();
  }, [tableToken]);

  // The diner cleared this phone's orders: the banner goes with them.
  useEffect(
    () =>
      onOrdersChanged(() => {
        if (getLastOrder(tableToken)) return;
        cache.delete(tableToken);
        setActive(null);
      }),
    [tableToken],
  );

  return active;
}

import { useEffect, useState } from 'react';
import { getOrder, isAbort } from './api';
import { forgetLastOrder, getLastOrder, isFinished } from './orderMemory';

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
        if (isFinished(order)) {
          forgetLastOrder(tableToken, token);
          update(null);
        } else {
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

  return active;
}

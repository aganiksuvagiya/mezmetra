import { useEffect, useState } from 'react';
import { getOrder, isAbort } from './api';
import { dropRecentOrder, getRecentOrders, onOrdersChanged, recordOrder } from './orderMemory';

/**
 * This device's latest orders at one restaurant, newest first. They show at once from what the device remembers, then the ones that
 * are still moving (not cancelled, not served and paid) are asked about again so their status is true. An order the restaurant has
 * removed disappears from the list. Finished orders are never asked about: their status cannot change. Only the current visit is
 * listed (see orderMemory), and the list follows a "clear" made anywhere on the page.
 */
export function useRecentOrders(vendorName) {
  const [orders, setOrders] = useState(() => getRecentOrders(vendorName));

  useEffect(() => {
    const remembered = getRecentOrders(vendorName);
    setOrders(remembered);
    const moving = remembered.filter((o) => !o.done);
    if (moving.length === 0) return undefined;

    const controller = new AbortController();
    Promise.allSettled(moving.map((o) => getOrder(o.token, { signal: controller.signal }).then((fresh) => ({ o, fresh })))).then((results) => {
      if (controller.signal.aborted) return;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') recordOrder(r.value.fresh, r.value.o.tableToken);
        else if (!isAbort(r.reason) && r.reason?.status === 404) dropRecentOrder(moving[i].token);
        // Any other failure (offline, server busy): keep what we remember; it is shown as it was.
      });
      setOrders(getRecentOrders(vendorName));
    });
    return () => controller.abort();
  }, [vendorName]);

  useEffect(() => onOrdersChanged(() => setOrders(getRecentOrders(vendorName))), [vendorName]);

  return orders;
}

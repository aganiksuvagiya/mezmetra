import { useCallback, useEffect, useRef, useState } from 'react';
import { getOrder, isAbort } from './api';

const FAST_MS = 5_000; // order still moving through the kitchen
const SLOW_MS = 20_000; // finished but unpaid: wait for the counter payment to show up
const MAX_BACKOFF_MS = 30_000;

/** Milliseconds until the next poll, or null when there is nothing left to wait for. */
function nextDelay(order, failures) {
  if (failures > 0) return Math.min(MAX_BACKOFF_MS, FAST_MS * 2 ** (failures - 1));
  if (order.status === 'pending' || order.status === 'accepted') return FAST_MS;
  if (order.status === 'completed' && order.payment_status !== 'paid') return SLOW_MS;
  return null; // cancelled, or completed and paid
}

/**
 * Follows one order: fetches immediately, then polls (5s while active, 20s while only payment is outstanding),
 * pauses while the tab is hidden, backs off on errors and keeps showing the last good data meanwhile.
 *
 * state: { status: 'loading' | 'ready' | 'notfound' | 'error', order, error, stale }
 */
export function useOrder(orderToken) {
  const [state, setState] = useState({ status: 'loading', order: null, error: null, stale: false });
  const orderRef = useRef(null);
  const failures = useRef(0);
  const timer = useRef(null);
  const controller = useRef(null);
  const fetchRef = useRef(() => {});

  const schedule = useCallback((order) => {
    clearTimeout(timer.current);
    const delay = nextDelay(order, failures.current);
    if (delay == null) return;
    timer.current = setTimeout(() => {
      // Hidden tabs skip the poll; the visibilitychange handler refreshes as soon as the tab is back.
      if (document.visibilityState === 'visible') fetchRef.current();
    }, delay);
  }, []);

  const fetchOnce = useCallback(async () => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    try {
      const order = await getOrder(orderToken, { signal: c.signal });
      failures.current = 0;
      orderRef.current = order;
      setState({ status: 'ready', order, error: null, stale: false });
      schedule(order);
    } catch (err) {
      if (isAbort(err) || c.signal.aborted) return;
      if (err.status === 404) {
        setState({ status: 'notfound', order: null, error: err, stale: false });
        return;
      }
      failures.current += 1;
      if (orderRef.current) {
        setState((s) => ({ ...s, stale: true }));
        schedule(orderRef.current);
      } else {
        setState({ status: 'error', order: null, error: err, stale: false });
      }
    }
  }, [orderToken, schedule]);

  fetchRef.current = fetchOnce;

  useEffect(() => {
    fetchOnce();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && orderRef.current) fetchOnce();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(timer.current);
      controller.current?.abort();
    };
  }, [fetchOnce]);

  /** Retry after a failed first load. */
  const reload = useCallback(() => {
    setState({ status: 'loading', order: null, error: null, stale: false });
    failures.current = 0;
    fetchOnce();
  }, [fetchOnce]);

  /** Use an order we already have (e.g. the payment verification response) without waiting for the next poll. */
  const applyOrder = useCallback(
    (order) => {
      failures.current = 0;
      orderRef.current = order;
      setState({ status: 'ready', order, error: null, stale: false });
      schedule(order);
    },
    [schedule],
  );

  return { state, refresh: fetchOnce, reload, applyOrder };
}

import { useCallback, useEffect, useState } from 'react';
import { BellIcon, CheckIcon, ReceiptIcon, SpinnerIcon } from './Icons';
import { useToast } from './Toast';
import { askService, errorMessage, getServiceRequests } from '../lib/api';

const REFRESH_MS = 15_000;

/**
 * "Call waiter" and "Ask for bill". Once asked, a button reads "Waiter called" until staff press Done (it re-checks every
 * few seconds), so a diner is never left wondering and never sends the same request twice.
 */
export default function ServiceButtons({ tableToken, className = '' }) {
  const toast = useToast();
  const [open, setOpen] = useState({ waiter: false, bill: false });
  const [busy, setBusy] = useState(null);

  const refresh = useCallback(() => {
    getServiceRequests(tableToken)
      .then((state) => setOpen({ waiter: Boolean(state.waiter), bill: Boolean(state.bill) }))
      .catch(() => {});
  }, [tableToken]);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => document.visibilityState === 'visible' && refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const ask = async (kind) => {
    if (busy || open[kind]) return;
    setBusy(kind);
    try {
      const state = await askService(tableToken, kind);
      setOpen({ waiter: Boolean(state.waiter), bill: Boolean(state.bill) });
      navigator.vibrate?.(8);
      toast.success(kind === 'bill' ? 'We have told the staff you would like the bill.' : 'We have called a waiter. Someone will be with you shortly.');
    } catch (err) {
      toast.error(errorMessage(err, 'We could not send that. Please wave to a member of staff.'));
    } finally {
      setBusy(null);
    }
  };

  const items = [
    ['waiter', 'Call waiter', 'Waiter called', BellIcon],
    ['bill', 'Ask for bill', 'Bill requested', ReceiptIcon],
  ];

  return (
    <div role="group" aria-label="Need something?" className={`flex flex-wrap gap-2 ${className}`}>
      {items.map(([kind, label, doneLabel, Icon]) => {
        const asked = open[kind];
        return (
          <button
            key={kind}
            type="button"
            onClick={() => ask(kind)}
            disabled={asked || busy !== null}
            aria-live="polite"
            className={`inline-flex min-h-10 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-bold transition-colors ${
              asked ? 'bg-emerald-100 text-emerald-900' : 'bg-white text-ink ring-1 ring-inset ring-black/10 hover:bg-black/[0.04] active:bg-black/[0.08]'
            } disabled:cursor-default`}
          >
            {busy === kind ? <SpinnerIcon className="size-4 animate-spin" /> : asked ? <CheckIcon className="size-4" /> : <Icon className="size-4" />}
            {asked ? doneLabel : label}
          </button>
        );
      })}
    </div>
  );
}

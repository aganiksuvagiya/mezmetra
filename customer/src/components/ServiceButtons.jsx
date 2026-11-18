import { useCallback, useEffect, useState } from 'react';
import { BellIcon, CheckIcon, ReceiptIcon, SpinnerIcon } from './Icons';
import { useToast } from './Toast';
import { askService, errorMessage, getServiceRequests } from '../lib/api';
import { getJSON, setJSON } from '../lib/storage';

const REFRESH_MS = 15_000;

// The restaurant keeps one open request of each kind per TABLE, but "Waiter called" is only true for the phone that asked: someone who
// scans the table later (or after the first diner left without staff pressing Done) must still be able to call. So each phone
// remembers which request it made (the time the server gave it) and only that one reads "called" here.
const mineKey = (tableToken) => `mezmitra_asked_${tableToken}`;
const readMine = (tableToken) => {
  const stored = getJSON(mineKey(tableToken), {});
  return stored && typeof stored === 'object' ? stored : {};
};
/** When the table's open request of this kind was made, or null when none is open. */
const sinceOf = (state, kind) => state?.[`${kind}_since`] ?? (state?.[kind] ? 'open' : null);

/**
 * "Call waiter" and "Ask for bill". Once this phone has asked, a button reads "Waiter called" until staff press Done (it re-checks
 * every few seconds), so a diner is never left wondering and never sends the same request twice.
 */
export default function ServiceButtons({ tableToken, className = '', grid = false }) {
  const toast = useToast();
  const [server, setServer] = useState({ waiter: null, bill: null }); // when each kind was last opened at this table
  const [mine, setMine] = useState(() => readMine(tableToken)); // which of those this phone asked for
  const [busy, setBusy] = useState(null);

  // A request staff have dealt with is gone for everyone: forget this phone's note about it.
  const settle = useCallback(
    (state) => {
      const next = { waiter: sinceOf(state, 'waiter'), bill: sinceOf(state, 'bill') };
      setServer(next);
      const stored = readMine(tableToken);
      const kept = Object.fromEntries(Object.entries(stored).filter(([kind, since]) => next[kind] && since === next[kind]));
      if (Object.keys(kept).length !== Object.keys(stored).length) setJSON(mineKey(tableToken), kept);
      setMine(kept);
    },
    [tableToken],
  );

  const refresh = useCallback(() => {
    getServiceRequests(tableToken)
      .then(settle)
      .catch(() => {});
  }, [tableToken, settle]);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => document.visibilityState === 'visible' && refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const isMine = (kind) => server[kind] !== null && mine[kind] === server[kind];

  const ask = async (kind) => {
    if (busy || isMine(kind)) return;
    setBusy(kind);
    try {
      const state = await askService(tableToken, kind);
      const since = sinceOf(state, kind);
      const kept = { ...readMine(tableToken), [kind]: since };
      setJSON(mineKey(tableToken), kept);
      setMine(kept);
      setServer({ waiter: sinceOf(state, 'waiter'), bill: sinceOf(state, 'bill') });
      navigator.vibrate?.(8);
      // Somebody at this table (or an earlier visit) already asked and staff have not yet pressed Done: the staff already know.
      toast.success(
        kind === 'bill'
          ? state.already_asked ? 'The staff already know this table would like the bill.' : 'We have told the staff you would like the bill.'
          : state.already_asked ? 'A waiter has already been called for this table. Someone will be with you shortly.' : 'We have called a waiter. Someone will be with you shortly.',
      );
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
    <div role="group" aria-label="Need something?" className={`${grid ? 'grid grid-cols-2 gap-2.5' : 'flex flex-wrap gap-2'} ${className}`}>
      {items.map(([kind, label, doneLabel, Icon]) => {
        const asked = isMine(kind);
        return (
          <button
            key={kind}
            type="button"
            onClick={() => ask(kind)}
            disabled={asked || busy !== null}
            aria-live="polite"
            className={`inline-flex items-center gap-1.5 font-bold transition-colors ${
              grid ? 'min-h-12 w-full justify-center rounded-2xl px-3 text-[15px]' : 'min-h-10 rounded-full px-3.5 text-[13px]'
            } ${
              asked ? 'bg-emerald-100 text-emerald-900' : 'bg-white text-ink ring-1 ring-inset ring-black/10 hover:bg-black/[0.04] active:bg-black/[0.08]'
            } disabled:cursor-default`}
          >
            {busy === kind ? <SpinnerIcon className="size-4 animate-spin" /> : asked ? <CheckIcon className="size-4" /> : <Icon className={grid ? 'size-5' : 'size-4'} />}
            {asked ? doneLabel : label}
          </button>
        );
      })}
    </div>
  );
}

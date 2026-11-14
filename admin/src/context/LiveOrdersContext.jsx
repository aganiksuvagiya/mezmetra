import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useToast } from '../components/Toast.jsx';
import { api, apiPage } from '../lib/api.js';
import { formatMoney } from '../lib/format.js';
import { useQuery } from '../lib/hooks.js';
import { announceOrders, announceRequests, audioRunning, playOrderChime, readSoundPref, soundSupported, speakSample, voiceActive, unlockAudio, writeSoundPref } from '../lib/orderAlert.js';

const noop = () => {};
const LiveOrdersContext = createContext({
  count: null,
  pending: 0,
  arrivals: 0,
  requests: [],
  resolveRequest: noop,
  reload: noop,
  sound: { supported: false, on: false, ready: false, toggle: noop },
});

export const useLiveOrders = () => useContext(LiveOrdersContext);

const POLL_MS = 8000;
const TITLE_COUNT = /^\(\d+\)\s/;

/**
 * Watches the restaurant's active (pending + accepted) orders every few seconds and tells the person about new ones,
 * wherever they are in the admin:
 *  - `count` feeds the badges, `pending` (orders waiting to be accepted) is shown in the browser tab title;
 *  - a chime plays and each new order is read out loud ("New order. Table 3. 2 items."), when the person switched sound on; a toast appears (except on the Orders page, which has its own),
 *    and a desktop notification is shown if the tab is in the background and the person allowed notifications;
 *  - `arrivals` counts new orders seen so far, so the Orders page can refresh the moment one comes in.
 * Orders that already exist when the page opens never trigger an alert.
 */
export function LiveOrdersProvider({ children }) {
  const toast = useToast();
  const { pathname } = useLocation();
  const q = useQuery(() => apiPage('/api/admin/orders', { query: { status: 'active', per_page: 20 } }), [], {
    interval: POLL_MS,
    pollInBackground: true,
  });
  const rows = q.data?.data;
  const count = q.data ? Number(q.data.meta.total) : null;
  const pending = rows ? rows.filter((o) => o.status === 'pending').length : 0;

  // Diners calling the waiter / asking for the bill.
  const rq = useQuery(() => api('/api/admin/requests'), [], { interval: POLL_MS, pollInBackground: true });
  const requests = rq.data ?? [];

  const [soundOn, setSoundOn] = useState(readSoundPref);
  const [soundReady, setSoundReady] = useState(audioRunning);
  const [arrivals, setArrivals] = useState(0);

  const latest = useRef({});
  useEffect(() => {
    latest.current = { soundOn, soundReady, onOrdersPage: pathname.startsWith('/orders') };
  });

  // New orders: anything newer than the newest order we have already seen.
  const newestSeen = useRef(null);
  useEffect(() => {
    if (!rows) return;
    const newest = rows.reduce((max, o) => Math.max(max, o.id), 0);
    if (newestSeen.current === null) {
      newestSeen.current = newest;
      return;
    }
    // New = newer than anything seen. Normally still pending; an order paid online is accepted by itself, so it counts too.
    const fresh = rows.filter((o) => o.id > newestSeen.current && (o.status === 'pending' || o.payment_status === 'paid'));
    newestSeen.current = Math.max(newestSeen.current, newest);
    if (fresh.length === 0) return;

    setArrivals((n) => n + fresh.length);
    const text =
      fresh.length === 1
        ? `New order #${fresh[0].id} from table ${fresh[0].table_number} (${formatMoney(fresh[0].total)})`
        : `${fresh.length} new orders`;
    if (latest.current.soundOn) {
      if (voiceActive()) {
        playOrderChime(1);
        setTimeout(() => announceOrders(fresh), 900); // let the chime finish first
      } else {
        playOrderChime();
      }
    }
    if (!latest.current.onOrdersPage) toast.info(text);
    if (document.visibilityState !== 'visible' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('New order', { body: text, tag: 'mezmitra-new-order' });
      } catch {
        /* some browsers only show notifications from a service worker */
      }
    }
  }, [rows, toast]);

  // A new waiter / bill request: chime, read out, toast (everywhere: staff must not miss a customer waiting).
  const newestRequest = useRef(null);
  useEffect(() => {
    if (!rq.data) return;
    const newest = rq.data.reduce((max, r) => Math.max(max, r.id), 0);
    if (newestRequest.current === null) {
      newestRequest.current = newest;
      return;
    }
    const fresh = rq.data.filter((r) => r.id > newestRequest.current);
    newestRequest.current = Math.max(newestRequest.current, newest);
    if (fresh.length === 0) return;
    const text = fresh.map((r) => `Table ${r.table_number} ${r.kind === 'bill' ? 'wants the bill' : 'is calling the waiter'}`).join(' · ');
    if (latest.current.soundOn) {
      playOrderChime(1);
      if (voiceActive()) setTimeout(() => announceRequests(fresh), 900);
    }
    toast.info(text);
    if (document.visibilityState !== 'visible' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('Customer needs you', { body: text, tag: 'mezmitra-request' });
      } catch {
        /* some browsers only show notifications from a service worker */
      }
    }
  }, [rq.data, toast]);

  const resolveRequest = useCallback(
    async (id) => {
      await api(`/api/admin/requests/${id}/done`, { method: 'POST' });
      await rq.reload();
    },
    [rq],
  );

  // Browser tab title: "(2) Orders · MezMitra Admin". Pages set their own title, so re-apply the count whenever it changes.
  useEffect(() => {
    const titleEl = document.querySelector('title');
    const strip = () => document.title.replace(TITLE_COUNT, '');
    const apply = () => {
      const next = pending > 0 ? `(${pending}) ${strip()}` : strip();
      if (document.title !== next) document.title = next;
    };
    apply();
    if (!titleEl) return undefined;
    const observer = new MutationObserver(apply);
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      document.title = strip();
    };
  }, [pending]);

  // The sound switch. Turning it on is the click browsers require before they let a page play audio.
  const toggleSound = useCallback(async () => {
    const { soundOn: on, soundReady: ready } = latest.current;
    if (on && !ready) {
      // Switched on earlier, but the browser locked audio again after a reload: this click unlocks it.
      if (await unlockAudio()) setSoundReady(true);
      return;
    }
    if (on) {
      writeSoundPref(false);
      setSoundOn(false);
      return;
    }
    if (!(await unlockAudio())) {
      toast.error("This browser didn't allow sound. Click anywhere on the page and try again.");
      return;
    }
    writeSoundPref(true);
    setSoundOn(true);
    setSoundReady(true);
    playOrderChime(1);
    if (voiceActive()) setTimeout(() => speakSample(), 900);
    toast.success(voiceActive() ? "Sound is on. You'll hear a chime and the table number for every new order." : "Sound is on. You'll hear a chime for every new order.");
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }, [toast]);

  // After a reload the choice is remembered, but audio is locked again until the first click or key press anywhere on the page.
  useEffect(() => {
    if (!soundOn || soundReady) return undefined;
    const unlock = async (event) => {
      if (event.target?.closest?.('[data-sound-toggle]')) return; // that button unlocks it itself
      if (await unlockAudio()) setSoundReady(true);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [soundOn, soundReady]);

  const value = useMemo(
    () => ({
      count,
      pending,
      arrivals,
      requests,
      resolveRequest,
      reload: q.reload,
      sound: { supported: soundSupported(), on: soundOn, ready: soundReady, toggle: toggleSound },
    }),
    [count, pending, arrivals, requests, resolveRequest, q.reload, soundOn, soundReady, toggleSound],
  );
  return <LiveOrdersContext value={value}>{children}</LiveOrdersContext>;
}

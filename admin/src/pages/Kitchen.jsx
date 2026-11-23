import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { ExpandIcon, LogoMark, MoonIcon, SunIcon, VolumeIcon, VolumeOffIcon } from '../components/icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { LiveOrdersProvider, useLiveOrders } from '../context/LiveOrdersContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { useDocumentTitle } from '../lib/hooks.js';

// The kitchen screen, drawn the way Apple draws its own apps: system fonts and colours, a grouped grey background, white cards with large
// rounded corners, hairline separators, tinted capsules and filled system buttons (the look itself lives in index.css as `.kitchen`).
// It is for a tablet or a spare monitor that stays on in the kitchen: outside the admin layout (no sidebar), no prices, light and dark.
// The three steps of an order are three columns:
//   New (waiting to be accepted) -> Preparing (accepted, being cooked) -> Ready (cooked, waiting for the waiter / the diner).
// Motion is only for what happened, with the system's own easing: a new ticket opens in, and a ticket that moves on glides to its new place.

const WARN_MIN = 8; // the wait turns orange after this many minutes since the order was placed
const LATE_MIN = 15; // red, "Late", after this many
const READY_STAYS_MIN = 30; // a ready order stays on screen this long (then it is only counted)
const OLD_ORDER_HOURS = 12; // an order this old that is still open is not "in the kitchen" any more (counted, not shown)
const SIZES = [13, 15, 18]; // root font size in px: small, medium (the default), large (everything is in rem, so the whole page scales)
const SIZE_KEY = 'mezmitra_kitchen_size_v2'; // v2: the sizes changed, so everyone starts again on Medium
const THEME_KEY = 'mezmitra_kitchen_theme';
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'; // the system's standard easing

const LANES = [
  { key: 'new', label: 'New', hint: 'Waiting to be accepted', dot: 'k-bg-orange', empty: 'No new orders' },
  { key: 'preparing', label: 'Preparing', hint: 'Being cooked', dot: 'k-bg-blue', empty: 'Nothing being cooked' },
  { key: 'ready', label: 'Ready', hint: 'Waiting to be served', dot: 'k-bg-green', empty: 'Nothing waiting' },
];

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const minutesSince = (iso, now) => Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
const spell = (min) => (min < 1 ? 'Just now' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`);

const readStored = (key) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeStored = (key, value) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice just is not remembered */
  }
};
const readSize = () => {
  const n = Number(readStored(SIZE_KEY));
  return Number.isInteger(n) && n >= 0 && n < SIZES.length && readStored(SIZE_KEY) !== null ? n : 1;
};
// The look: what was chosen last time, else what the device itself is set to.
const readTheme = () => {
  const saved = readStored(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

/**
 * Makes tickets move instead of jump. After every render each visible ticket's place is compared with where it was: a ticket that moved
 * (to another column, or up because the one above it left) glides there; a new order opens in; and the first time tickets are shown they
 * come in one after another. `arrivedAt` says which orders are new since the screen was opened. Returns the ref for each ticket.
 */
function useFlip(arrivedAt, active) {
  const els = useRef(new Map());
  const prev = useRef(new Map());
  const firstPaint = useRef(true);
  const ref = useCallback(
    (id) => (el) => {
      if (el) els.current.set(id, el);
      else els.current.delete(id);
    },
    [],
  );

  useLayoutEffect(() => {
    const next = new Map();
    els.current.forEach((el, id) => {
      if (el.offsetParent === null) return; // on a tab that is not showing
      const r = el.getBoundingClientRect();
      next.set(id, { x: r.left + window.scrollX, y: r.top + window.scrollY });
    });
    if (active && next.size > 0 && !reducedMotion()) {
      let i = 0;
      next.forEach((pos, id) => {
        const el = els.current.get(id);
        const old = firstPaint.current ? null : prev.current.get(id);
        if (!old) {
          if (firstPaint.current) {
            el.animate([{ opacity: 0, transform: 'translateY(12px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 480, delay: i * 55, easing: EASE, fill: 'backwards' });
            i += 1;
          } else if ((arrivedAt.current.get(id) ?? 0) > 0 && Date.now() - arrivedAt.current.get(id) < 6000) {
            el.animate([{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: EASE });
          }
          return;
        }
        const dx = old.x - pos.x;
        const dy = old.y - pos.y;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        el.style.zIndex = '30';
        const move = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 520, easing: EASE });
        move.onfinish = move.oncancel = () => {
          el.style.zIndex = '';
        };
      });
      firstPaint.current = false;
    }
    prev.current = next;
  });
  return ref;
}

/** The segmented control: a grey track and a white thumb that slides to the chosen segment. */
function Segmented({ label, value, onChange, options, className }) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role="group" aria-label={label} className={cx('k-fill relative grid auto-cols-fr grid-flow-col rounded-[0.5rem] p-0.5', className)}>
      <span
        aria-hidden="true"
        className="k-thumb absolute inset-y-0.5 left-0.5 rounded-[0.375rem] transition-transform duration-300"
        style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${idx * 100}%)`, transitionTimingFunction: EASE }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          aria-label={o.label}
          title={o.title}
          className={cx('relative z-10 flex h-8 min-w-9 items-center justify-center gap-1.5 rounded-[0.375rem] px-2.5 text-[0.8125rem] font-semibold transition-colors', o.value === value ? 'k-l1' : 'k-l2')}
        >
          {o.content}
        </button>
      ))}
    </div>
  );
}

const RoundButton = ({ children, ...props }) => (
  <button type="button" {...props} className="k-fill k-l1 relative inline-flex size-9 items-center justify-center rounded-lg transition before:absolute before:-inset-1.5 before:content-[''] active:scale-95 active:opacity-70">
    {children}
  </button>
);

/** The small capsule button Apple uses inside lists and cards (like "Get" in the App Store): compact, rounded all the way, one per card. */
const Capsule = ({ busy, onClick, tone, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={busy}
    className={cx('relative h-9 min-w-[4.75rem] rounded-lg px-4 text-[0.9375rem] font-semibold text-white transition duration-150 before:absolute before:-inset-1.5 before:content-[\'\'] active:scale-95 active:opacity-80 disabled:opacity-50', tone)}
  >
    {busy ? <span className="inline-block size-4 animate-spin rounded-full border-2 border-white/40 border-t-white align-[-3px]" aria-label="Please wait" /> : children}
  </button>
);

/** The round "more" button. As on iOS, the rarely used, destructive choice lives in a small menu behind it, not next to the main button. */
function MoreMenu({ disabled, onReject }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (!box.current?.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        className="k-fill k-l2 relative inline-flex size-9 items-center justify-center rounded-lg transition before:absolute before:-inset-1.5 before:content-[''] active:scale-95 active:opacity-70 disabled:opacity-40"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.9" />
          <circle cx="12" cy="12" r="1.9" />
          <circle cx="19" cy="12" r="1.9" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="k-card absolute right-0 top-full z-40 mt-2 min-w-[11rem] overflow-hidden rounded-[0.625rem] py-1" style={{ boxShadow: '0 10px 32px rgba(0,0,0,0.22), 0 0 0 0.5px var(--k-sep)' }}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onReject();
            }}
            className="k-red flex w-full items-center justify-between gap-6 px-4 py-3 text-left text-[0.9375rem] transition active:opacity-60"
          >
            Can&rsquo;t make it
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

/** One order as a card: the table, the dishes as a plain list, and a small capsule button in the corner (the way the App Store puts "Get"). */
function Ticket({ order, lane, now, fresh, busy, flipRef, onAccept, onReady, onReject }) {
  const age = minutesSince(order.created_at, now);
  const late = lane !== 'ready' && age >= LATE_MIN;
  const warn = lane !== 'ready' && !late && age >= WARN_MIN;
  const items = order.items.reduce((n, i) => n + i.quantity, 0);

  let pill = { cls: 'k-pill-gray', text: spell(age) };
  if (lane === 'ready') pill = { cls: 'k-pill-green', text: `Ready · ${spell(minutesSince(order.ready_at, now))}${minutesSince(order.ready_at, now) < 1 ? '' : ' ago'}` };
  else if (late) pill = { cls: 'k-pill-red', text: `Late · ${spell(age)}` };
  else if (warn) pill = { cls: 'k-pill-orange', text: spell(age) };

  return (
    <li ref={flipRef} className={cx('k-card rounded-xl pb-3 pt-4', fresh && 'k-fresh')}>
      <div className="flex items-start justify-between gap-3 px-4">
        <div className="min-w-0">
          <p className="k-l2 text-[0.8125rem] font-semibold">
            {fresh && <span className="k-blue mr-1.5">New ·</span>}
            Table
          </p>
          <p className="truncate text-[2rem] font-bold leading-[1.05] tracking-[-0.025em]">{order.table_number}</p>
        </div>
        {lane !== 'ready' && (
          <div className="flex shrink-0 items-center gap-2 pt-1">
            {lane === 'new' && <MoreMenu disabled={busy} onReject={onReject} />}
            {lane === 'new' && (
              <Capsule busy={busy} onClick={onAccept} tone="k-fill-blue">
                Accept
              </Capsule>
            )}
            {lane === 'preparing' && (
              <Capsule busy={busy} onClick={onReady} tone="k-fill-green">
                Ready
              </Capsule>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 px-4 pt-1.5">
        <p className="k-l2 text-[0.8125rem]">
          Order #{order.number} · {items} {items === 1 ? 'item' : 'items'}
        </p>
        <span className={cx('inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[0.8125rem] font-semibold tabular-nums', pill.cls)}>{pill.text}</span>
      </div>

      <ul className="k-divide k-sep-t mt-3">
        {order.items.map((item, i) => (
          <li key={item.id ?? i} className="flex items-start gap-3 px-4 py-2.5">
            <span className="k-fill grid size-7 shrink-0 place-items-center rounded-md text-[0.8125rem] font-semibold tabular-nums">{item.quantity}</span>
            <div className="min-w-0 pt-px">
              <p className="break-words text-[1rem] font-semibold leading-snug tracking-[-0.015em]">{item.name}</p>
              {item.options?.length > 0 && <p className="k-l2 text-[0.8125rem]">{item.options.map((o) => o.name).join(' · ')}</p>}
              {item.instructions && <p className="k-orange mt-0.5 break-words text-[0.8125rem] font-semibold">{item.instructions}</p>}
            </div>
          </li>
        ))}
      </ul>

      {order.note && (
        <div className="px-4 pt-1">
          <p className="k-note break-words rounded-lg px-3 py-2 text-[0.8125rem]">
            <span className="mr-1.5 font-bold">Note</span>
            {order.note}
          </p>
        </div>
      )}
    </li>
  );
}

function Kitchen() {
  useDocumentTitle('Kitchen');
  const { vendor, logout } = useAuth();
  const isKitchen = vendor?.role === 'kitchen'; // the kitchen's own login: no way back to the rest of the admin
  const toast = useToast();
  const { orders, updatedAt, error, reload, sound } = useLiveOrders();
  const now = useNow(5000);

  const [started, setStarted] = useState(false);
  const [tab, setTab] = useState('new'); // below the large breakpoint only one column is shown at a time
  const [sizeIdx, setSizeIdx] = useState(readSize);
  const [look, setLook] = useState(readTheme);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [rejecting, setRejecting] = useState(null);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [awake, setAwake] = useState(false);

  // A bigger or smaller screen text: the whole page scales (everything is in rem).
  useEffect(() => {
    document.documentElement.style.fontSize = `${SIZES[sizeIdx]}px`;
    writeStored(SIZE_KEY, String(sizeIdx));
    return () => {
      document.documentElement.style.fontSize = '';
    };
  }, [sizeIdx]);
  useEffect(() => writeStored(THEME_KEY, look), [look]);

  // Keep the screen from going to sleep (where the browser supports it). It is given up when the tab is hidden, so take it again when back.
  const lock = useRef(null);
  const keepAwake = useCallback(async () => {
    try {
      if (!navigator.wakeLock || lock.current) return;
      lock.current = await navigator.wakeLock.request('screen');
      setAwake(true);
      lock.current.addEventListener('release', () => {
        lock.current = null;
        setAwake(false);
      });
    } catch {
      /* the browser refused (battery saver, not visible): the screen may sleep, nothing else breaks */
    }
  }, []);
  useEffect(() => {
    if (!started) return undefined;
    const back = () => document.visibilityState === 'visible' && keepAwake();
    document.addEventListener('visibilitychange', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      lock.current?.release?.();
    };
  }, [started, keepAwake]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };

  // Starting is a click: browsers only allow sound (and keeping the screen on) after one.
  const start = async () => {
    if (sound.supported && (!sound.on || !sound.ready)) await sound.toggle();
    await keepAwake();
    setStarted(true);
  };

  // Which orders arrived while this screen was open (those are marked "New" for a few seconds). What was there at the start never is.
  // (Filled while rendering, so a new order is marked from its very first paint; filling it again changes nothing.)
  const arrivedAt = useRef(new Map());
  const firstLoad = useRef(true);
  if (orders) {
    for (const o of orders) {
      if (!arrivedAt.current.has(o.id)) arrivedAt.current.set(o.id, firstLoad.current ? 0 : Date.now());
    }
    firstLoad.current = false;
  }
  const flipRef = useFlip(arrivedAt, started);

  // On a small screen only one column shows: start on the first one that has something in it (once, when the orders first load).
  const tabChosen = useRef(false);
  useEffect(() => {
    if (!orders || tabChosen.current) return;
    tabChosen.current = true;
    const has = (pred) => orders.some(pred);
    if (has((o) => o.status === 'pending')) setTab('new');
    else if (has((o) => o.status === 'accepted' && !o.ready_at)) setTab('preparing');
    else if (has((o) => o.status === 'accepted' && o.ready_at)) setTab('ready');
  }, [orders]);

  const { lanes, older, toCook, longest } = useMemo(() => {
    const cols = { new: [], preparing: [], ready: [] };
    let hidden = 0;
    const oldest = (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at);
    for (const o of orders ?? []) {
      if (now - Date.parse(o.created_at) > OLD_ORDER_HOURS * 3600000) {
        hidden += 1;
        continue;
      }
      if (o.status === 'pending') cols.new.push(o);
      else if (o.status === 'accepted' && !o.ready_at) cols.preparing.push(o);
      else if (o.status === 'accepted' && o.ready_at) {
        if (now - Date.parse(o.ready_at) <= READY_STAYS_MIN * 60000) cols.ready.push(o);
        else hidden += 1;
      }
    }
    cols.new.sort(oldest);
    cols.preparing.sort(oldest);
    cols.ready.sort((a, b) => Date.parse(a.ready_at) - Date.parse(b.ready_at));

    // What is to be cooked right now, added up over the open orders: "4 Masala Chaas".
    const sums = new Map();
    const open = [...cols.new, ...cols.preparing];
    for (const o of open) for (const i of o.items) sums.set(i.name, (sums.get(i.name) ?? 0) + i.quantity);
    const cook = [...sums.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { lanes: cols, older: hidden, toCook: cook, longest: open.length ? Math.max(...open.map((o) => minutesSince(o.created_at, now))) : null };
  }, [orders, now]);

  // One request at a time per order (a second tap on the same ticket does nothing), then show the new state at once.
  const act = async (order, request) => {
    if (busyIds.has(order.id)) return;
    setBusyIds((s) => new Set(s).add(order.id));
    try {
      await request();
      await reload();
    } catch (e) {
      toast.error(e?.message || "That didn't work. Please try again.");
    } finally {
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(order.id);
        return next;
      });
    }
  };
  const accept = (o) => act(o, () => api(`/api/admin/orders/${o.id}/status`, { method: 'PATCH', body: { status: 'accepted' } }));
  const ready = (o) => act(o, () => api(`/api/admin/orders/${o.id}/ready`, { method: 'POST' }));
  const reject = async (o) => {
    await api(`/api/admin/orders/${o.id}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
    await reload();
  };

  const stale = Boolean(error) && updatedAt && now - updatedAt.getTime() > 20000;
  const total = lanes.new.length + lanes.preparing.length + lanes.ready.length;
  const clock = new Date(now).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  const figures = [
    { label: 'New', value: lanes.new.length, dot: 'k-bg-orange' },
    { label: 'Cooking', value: lanes.preparing.length, dot: 'k-bg-blue' },
    { label: 'Ready', value: lanes.ready.length, dot: 'k-bg-green' },
    {
      label: 'Longest wait',
      value: longest === null ? '—' : longest,
      unit: longest === null ? '' : 'min',
      dot: longest !== null && longest >= LATE_MIN ? 'k-bg-red' : longest !== null && longest >= WARN_MIN ? 'k-bg-orange' : 'k-fill',
      tone: longest !== null && longest >= LATE_MIN ? 'k-red' : '',
    },
  ];
  const laneOptions = LANES.map((c) => ({
    value: c.key,
    label: c.label,
    content: (
      <>
        {c.label}
        <span className={cx('tabular-nums', c.key === 'new' && lanes.new.length > 0 ? 'k-orange' : 'k-l3')}>{lanes[c.key].length}</span>
      </>
    ),
  }));

  return (
    <div className="kitchen flex min-h-dvh flex-col" data-look={look}>
      <header className="k-bar sticky top-0 z-20">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2">
          <div className="flex items-center gap-2.5">
            <LogoMark size={32} />
            <div className="leading-tight">
              <h1 className="text-[1.1875rem] font-bold tracking-[-0.02em]">Kitchen</h1>
              <p className="k-l2 max-w-[14rem] truncate text-[0.8125rem]">{vendor?.name}</p>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <p className="mr-1 text-[0.9375rem] font-semibold tabular-nums">{clock}</p>
            <span className={cx('inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[0.8125rem] font-semibold', stale ? 'k-pill-red' : 'k-pill-green')}>
              <span className={cx('size-2 rounded-full', stale ? 'k-bg-red' : 'k-bg-green')} />
              {stale ? 'Offline' : 'Live'}
            </span>
            {sound.supported && (
              <button
                type="button"
                data-sound-toggle
                onClick={sound.toggle}
                aria-pressed={sound.on}
                aria-label={sound.on ? (sound.ready ? 'Sound on. Tap to turn off.' : 'Tap to enable sound') : 'Sound off. Tap to turn on.'}
                className={cx('inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[0.8125rem] font-semibold transition active:scale-95', sound.on && sound.ready ? 'k-fill k-l1' : 'k-pill-orange')}
              >
                {sound.on ? <VolumeIcon size={17} /> : <VolumeOffIcon size={17} />}
                <span className={sound.on && sound.ready ? 'hidden lg:inline' : ''}>{sound.on ? (sound.ready ? 'Sound on' : 'Tap to enable sound') : 'Sound off'}</span>
              </button>
            )}
            <Segmented
              label="Look"
              value={look}
              onChange={setLook}
              options={[
                { value: 'light', label: 'Light look', title: 'Light look', content: <SunIcon size={16} /> },
                { value: 'dark', label: 'Dark look', title: 'Dark look', content: <MoonIcon size={16} /> },
              ]}
            />
            <Segmented
              label="Text size"
              value={['small', 'medium', 'large'][sizeIdx]}
              onChange={(v) => setSizeIdx(['small', 'medium', 'large'].indexOf(v))}
              options={[
                { value: 'small', label: 'Small text', title: 'Small text', content: <span className="text-[0.75rem]">A</span> },
                { value: 'medium', label: 'Medium text', title: 'Medium text', content: <span className="text-[0.8125rem]">A</span> },
                { value: 'large', label: 'Large text', title: 'Large text', content: <span className="text-[1rem]">A</span> },
              ]}
            />
            {document.documentElement.requestFullscreen && (
              <RoundButton onClick={toggleFullscreen} aria-pressed={fullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'}>
                <ExpandIcon size={17} />
              </RoundButton>
            )}
            {isKitchen ? (
              <button type="button" onClick={logout} className="k-blue px-1.5 py-2 text-[0.9375rem] font-medium transition active:opacity-60">
                Sign out
              </button>
            ) : (
              <Link to="/orders" className="k-blue px-1.5 py-2 text-[0.9375rem] font-medium transition active:opacity-60">
                Admin
              </Link>
            )}
          </div>
        </div>

        {/* Below the large breakpoint the three columns become one control. */}
        <div className="px-4 pb-2.5 lg:hidden">
          <Segmented label="Order steps" value={tab} onChange={setTab} options={laneOptions} className="w-full" />
        </div>
      </header>

      {stale && (
        <p role="alert" className="k-fill-red px-5 py-2.5 text-center text-[0.875rem] font-semibold text-white">
          No connection. These orders are as of {updatedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. New orders will not show until it is back.
        </p>
      )}

      <main id="main-content" className="flex-1 px-3 pb-6 pt-3 sm:px-5">
        {!orders && !error && <p className="k-l2 py-16 text-center text-[0.9375rem]">Loading orders…</p>}
        {!orders && error && <p className="k-red py-16 text-center text-[0.9375rem]">Couldn&rsquo;t load the orders. Trying again…</p>}

        {orders && (
          <>
            {/* The board in four figures. */}
            <dl className="k-grid-lines k-shadow mb-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl sm:grid-cols-4">
              {figures.map((f) => (
                <div key={f.label} className="k-surface px-4 py-3">
                  <dt className="k-l2 flex items-center gap-2 text-[0.8125rem] font-semibold">
                    <span className={cx('size-2.5 rounded-full', f.dot)} />
                    {f.label}
                  </dt>
                  <dd className={cx('mt-1 text-[1.5rem] font-bold leading-none tracking-[-0.03em] tabular-nums', f.tone)}>
                    {f.value}
                    {f.unit && <span className="k-l2 ml-1 text-[0.875rem] font-semibold tracking-normal">{f.unit}</span>}
                  </dd>
                </div>
              ))}
            </dl>

            {/* What to cook right now, added up over the open orders. */}
            {toCook.length > 0 && (
              <div className="mb-4">
                <p className="k-l2 mb-1.5 px-1 text-[0.75rem] font-semibold uppercase tracking-wide">To cook</p>
                <ul className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 sm:-mx-5 sm:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {toCook.map(([name, qty]) => (
                    <li key={name} className="k-card flex shrink-0 items-center gap-1.5 rounded-lg py-1 pl-1 pr-2.5 text-[0.8125rem] font-medium">
                      <span className="k-fill grid min-w-6 place-items-center rounded-md px-1.5 py-px text-[0.8125rem] font-semibold tabular-nums">{qty}</span>
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid items-start gap-4 lg:grid-cols-3">
              {LANES.map((c) => (
                <section key={c.key} aria-labelledby={`col-${c.key}`} className={cx(tab === c.key ? 'block' : 'hidden', 'lg:block')}>
                  <div className="mb-2.5 hidden items-center gap-2 px-1 lg:flex">
                    <span className={cx('size-2.5 rounded-full', c.dot)} aria-hidden="true" />
                    <h2 id={`col-${c.key}`} className="text-[1.1875rem] font-bold tracking-[-0.02em]">
                      {c.label}
                    </h2>
                    <span className="k-l3 text-[0.9375rem] font-semibold tabular-nums">{lanes[c.key].length}</span>
                    <span className="k-l3 ml-auto text-[0.8125rem]">{c.hint}</span>
                  </div>
                  {lanes[c.key].length === 0 ? (
                    <p className="k-card k-l3 rounded-xl px-4 py-8 text-center text-[0.9375rem] font-medium">{c.empty}</p>
                  ) : (
                    <ul className="space-y-3">
                      {lanes[c.key].map((o) => (
                        <Ticket
                          key={o.id}
                          order={o}
                          lane={c.key}
                          now={now}
                          flipRef={flipRef(o.id)}
                          fresh={(arrivedAt.current.get(o.id) ?? 0) > 0 && now - arrivedAt.current.get(o.id) < 20000}
                          busy={busyIds.has(o.id)}
                          onAccept={() => accept(o)}
                          onReady={() => ready(o)}
                          onReject={() => setRejecting(o)}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          </>
        )}

        {orders && total === 0 && <p className="k-l2 mt-8 text-center text-[0.9375rem] font-medium">All clear. New orders appear here with a chime.</p>}
        {older > 0 && (
          <p className="k-l3 mt-6 text-center text-[0.8125rem]">
            {older} older {older === 1 ? 'order is' : 'orders are'} still open (ready a while ago, or from before today).
            {!isKitchen && (
              <>
                {' '}
                See{' '}
                <Link to="/orders" className="k-blue font-medium">
                  Orders
                </Link>
                .
              </>
            )}
          </p>
        )}
        {started && !awake && 'wakeLock' in navigator && <p className="k-l3 mt-4 text-center text-[0.8125rem]">The screen may go to sleep on this device.</p>}
      </main>

      {!started && (
        <div role="dialog" aria-modal="true" aria-labelledby="start-title" className="kitchen fixed inset-0 z-40 flex items-center justify-center p-5" data-look={look}>
          <div className="k-card w-full max-w-[17rem] rounded-xl px-5 pb-5 pt-6 text-center">
            <LogoMark size={44} className="mx-auto" />
            <h2 id="start-title" className="mt-3 text-[1.125rem] font-bold tracking-[-0.02em]">
              Kitchen screen
            </h2>
            <p className="k-l2 mt-0.5 text-[0.8125rem]">{vendor?.name}</p>
            <p className="k-l2 mx-auto mt-3 text-[0.8125rem] leading-snug">A chime and the table number for every new order, and the screen stays awake. Tickets are big, with no prices.</p>
            <button
              type="button"
              onClick={start}
              data-autofocus
              className="k-fill-blue mt-5 h-[2.75rem] w-full rounded-[0.625rem] text-[0.875rem] font-semibold text-white transition duration-150 active:scale-[0.98] active:opacity-85"
            >
              Start
            </button>
            <p className="k-l3 mt-2.5 text-[0.75rem]">Leave this tablet on and plugged in.</p>
            {isKitchen ? (
              <button type="button" onClick={logout} className="k-blue mt-2 inline-block text-[0.8125rem] font-medium">
                Sign out
              </button>
            ) : (
              <Link to="/orders" className="k-blue mt-2 inline-block text-[0.8125rem] font-medium">
                Back to admin
              </Link>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(rejecting)}
        title={rejecting ? `Can't make order #${rejecting.number}?` : ''}
        message={rejecting ? `Table ${rejecting.table_number}: the order is cancelled and the diner sees it as cancelled. This can't be undone.` : ''}
        confirmLabel="Yes, cancel the order"
        cancelLabel="Keep it"
        onCancel={() => setRejecting(null)}
        onConfirm={async () => {
          await reject(rejecting);
          toast.success(`Order #${rejecting.number} was cancelled.`);
          setRejecting(null);
        }}
      />
    </div>
  );
}

/** The kitchen screen needs the same live feed (and the new-order sound) as the admin, so it brings its own. */
export default function KitchenPage() {
  return (
    <LiveOrdersProvider>
      <Kitchen />
    </LiveOrdersProvider>
  );
}

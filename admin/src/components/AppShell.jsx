import NotificationsPanel from './NotificationsPanel.jsx';
import RequestsBanner from './RequestsBanner.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { LiveOrdersProvider, useLiveOrders } from '../context/LiveOrdersContext.jsx';
import { cx } from '../lib/cx.js';
import { useMediaQuery } from '../lib/hooks.js';
import { SidePanelProvider, useSidePanelSpace } from '../context/SidePanelContext.jsx';
import {
  BellIcon,
  CardIcon,
  CloseIcon,
  DashboardIcon,
  ListIcon,
  LogoMark,
  LogoutIcon,
  MenuIcon,
  OrdersIcon,
  QrIcon,
  PaletteIcon,
  SettingsIcon,
  ShieldIcon,
  TableIcon,
  TagIcon,
  TrendingIcon,
  VolumeIcon,
  VolumeOffIcon,
} from './icons.jsx';

const NAV = [
  { to: '/', label: 'Dashboard', icon: DashboardIcon },
  {
    heading: 'Menu',
    items: [
      { to: '/menu/categories', label: 'Categories', icon: TagIcon },
      { to: '/menu/items', label: 'Items', icon: ListIcon },
    ],
  },
  {
    heading: 'Tables',
    items: [
      { to: '/tables', label: 'Tables', icon: TableIcon },
      { to: '/tables/qr', label: 'QR codes', icon: QrIcon },
    ],
  },
  { to: '/orders', label: 'Orders', icon: OrdersIcon, live: true },
  { to: '/payments', label: 'Payments', icon: CardIcon },
  { to: '/reports', label: 'Reports', icon: TrendingIcon },
  { to: '/appearance', label: 'Appearance', icon: PaletteIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function NavItem({ to, label, icon: Icon, live }) {
  const { count } = useLiveOrders();
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        cx(
          'group relative flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors lg:h-10',
          isActive
            ? 'bg-brand-50 font-semibold text-brand-800 before:absolute before:inset-y-2 before:-left-3 before:w-1 before:rounded-r-full before:bg-brand-600'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon size={19} className={isActive ? 'text-brand-600' : 'text-slate-400 group-hover:text-slate-600'} />
          <span className="flex-1">{label}</span>
          {live && count > 0 && (
            <span className="min-w-6 rounded-full bg-brand-600 px-1.5 py-0.5 text-center text-xs font-semibold text-white">
              {count}
              <span className="sr-only"> live {count === 1 ? 'order' : 'orders'}</span>
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

/** Switch for the new-order chime. Browsers only allow sound after a click, which is why this is a button and not a setting. */
function SoundToggle({ pill = false }) {
  const { sound } = useLiveOrders();
  if (!sound.supported) return null;
  const waiting = sound.on && !sound.ready;
  const Icon = sound.on ? VolumeIcon : VolumeOffIcon;
  const label = waiting ? 'New-order sound: click to enable' : sound.on ? 'New-order sound is on. Click to turn off.' : 'New-order sound is off. Click to turn on.';
  const tone = waiting ? 'text-amber-700' : sound.on ? 'text-brand-600' : 'text-slate-400';

  if (!pill) {
    return (
      <button
        type="button"
        data-sound-toggle
        onClick={sound.toggle}
        aria-pressed={sound.on}
        aria-label={label}
        title={label}
        className={cx('inline-flex size-10 items-center justify-center rounded-lg hover:bg-slate-100', tone)}
      >
        <Icon size={20} />
      </button>
    );
  }
  return (
    <button
      type="button"
      data-sound-toggle
      onClick={sound.toggle}
      aria-pressed={sound.on}
      title={label}
      className={cx(
        'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold ring-1 ring-inset transition-colors',
        waiting
          ? 'bg-amber-50 text-amber-800 ring-amber-200 hover:bg-amber-100'
          : sound.on
            ? 'bg-emerald-50 text-emerald-800 ring-emerald-200 hover:bg-emerald-100'
            : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-50',
      )}
    >
      <Icon size={16} />
      {waiting ? 'Enable sound' : sound.on ? 'Sound on' : 'Sound off'}
    </button>
  );
}

/** The notification bell: how many things are waiting for staff (orders to accept, customers calling, UPI payments to confirm). */
function NotificationBell({ onOpen, open }) {
  const { notifications } = useLiveOrders();
  const n = notifications.length;
  const label = n > 0 ? `Notifications: ${n} waiting for you` : 'Notifications: nothing waiting';
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={cx(
        'relative inline-flex size-10 items-center justify-center rounded-lg hover:bg-slate-100',
        n > 0 ? 'text-slate-800' : 'text-slate-500',
      )}
    >
      <BellIcon size={21} />
      {n > 0 && (
        <span
          aria-hidden="true"
          className="absolute right-0 top-0 min-w-[1.15rem] rounded-full bg-red-600 px-1 text-center text-[11px] font-bold leading-[1.15rem] text-white ring-2 ring-white"
        >
          {n > 9 ? '9+' : n}
        </span>
      )}
    </button>
  );
}

function Sidebar({ onClose, showClose }) {
  const { vendor, logout } = useAuth();
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
        <Link to="/" className="flex items-center gap-2.5 rounded-lg">
          <LogoMark size={34} />
          <span className="text-lg font-bold tracking-tight text-slate-900">
            Mez<span className="text-brand-600">Mitra</span>
          </span>
        </Link>
        {showClose && (
          <button
            type="button"
            onClick={onClose}
            data-autofocus
            aria-label="Close menu"
            className="inline-flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
          >
            <CloseIcon size={20} />
          </button>
        )}
      </div>

      <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {NAV.map((entry) =>
          entry.items ? (
            <div key={entry.heading} className="pt-3">
              <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">{entry.heading}</p>
              <div className="space-y-1">
                {entry.items.map((item) => (
                  <NavItem key={item.to} {...item} />
                ))}
              </div>
            </div>
          ) : (
            <NavItem key={entry.to} {...entry} />
          ),
        )}
        {vendor?.is_super_admin && (
          <div className="pt-3">
            <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">Platform</p>
            <NavItem to="/platform" label="All restaurants" icon={ShieldIcon} />
          </div>
        )}
      </nav>

      <div className="shrink-0 border-t border-slate-200 p-3">
        <div className="mb-2 flex items-center gap-3 rounded-xl bg-slate-50 p-2.5">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            {(vendor?.name ?? '?').trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900" title={vendor?.name}>
              {vendor?.name}
            </p>
            <p className="truncate text-xs text-slate-500" title={vendor?.email}>
              {vendor?.email}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={logout}
          className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        >
          <LogoutIcon size={18} className="text-slate-400" />
          Sign out
        </button>
      </div>
    </div>
  );
}

function Shell() {
  const [open, setOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const location = useLocation();
  const hamburgerRef = useRef(null);
  const { count } = useLiveOrders();
  const { open: panelDocked } = useSidePanelSpace();
  const { vendor } = useAuth();
  // "Thursday, 19 November" in the restaurant's own time zone.
  const today = useMemo(
    () => new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: vendor?.timezone || undefined }).format(new Date()),
    [vendor?.timezone],
  );

  // Navigating closes the drawer (and moves focus to the new page, since the link that was clicked is now hidden);
  // so does growing the window past the breakpoint.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    if (openRef.current) {
      // The page behind the drawer is inert until the drawer has closed, so focus it on the next frame.
      requestAnimationFrame(() => document.getElementById('main-content')?.focus({ preventScroll: true }));
    }
    setOpen(false);
    window.scrollTo(0, 0);
  }, [location.pathname]);
  useEffect(() => {
    if (isDesktop) setOpen(false);
  }, [isDesktop]);

  const closeDrawer = () => {
    setOpen(false);
    hamburgerRef.current?.focus();
  };

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Move focus into the drawer when it opens.
  const drawerRef = useRef(null);
  useEffect(() => {
    if (open) drawerRef.current?.querySelector('[data-autofocus]')?.focus();
  }, [open]);

  const drawerOpenOnMobile = !isDesktop && open;

  return (
    <div className="min-h-dvh">
      <a
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
        className="sr-only z-[70] rounded-lg bg-white px-4 py-2 text-sm font-semibold text-brand-700 shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>

      {/* Off-canvas drawer below 1024px (closed by default, and inert while closed so Tab skips it); fixed sidebar above. */}
      <div
        className={cx(
          'fixed inset-0 z-40 bg-slate-900/50 transition-opacity lg:hidden print:hidden',
          drawerOpenOnMobile ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        aria-hidden="true"
        onMouseDown={closeDrawer}
      />
      <aside
        id="sidebar"
        ref={drawerRef}
        inert={!isDesktop && !open}
        className={cx(
          'fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r border-slate-200 shadow-xl transition-transform duration-200 ease-out print:hidden',
          'lg:z-30 lg:w-64 lg:max-w-none lg:translate-x-0 lg:shadow-none',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <Sidebar onClose={closeDrawer} showClose={!isDesktop} />
      </aside>

      <div
        inert={drawerOpenOnMobile}
        className={'transition-[padding] duration-200 lg:pl-64 print:pl-0' + (panelDocked ? ' lg:pr-[22rem] xl:pr-[26rem]' : '')}
      >
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/95 px-3 backdrop-blur lg:hidden print:hidden">
          <button
            ref={hamburgerRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="sidebar"
            className="inline-flex size-10 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100"
          >
            <MenuIcon size={22} />
          </button>
          <Link to="/" className="flex items-center gap-2">
            <LogoMark size={28} />
            <span className="font-bold tracking-tight text-slate-900">
              Mez<span className="text-brand-600">Mitra</span>
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-1">
            {count > 0 && (
              <Link
                to="/orders"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-brand-50 px-3 text-xs font-semibold text-brand-800 ring-1 ring-inset ring-brand-200"
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-brand-500" />
                {count} live
                <span className="sr-only min-[420px]:not-sr-only">{count === 1 ? 'order' : 'orders'}</span>
              </Link>
            )}
            <SoundToggle />
            <NotificationBell open={notificationsOpen} onOpen={() => setNotificationsOpen((v) => !v)} />
          </div>
        </header>

        {/* On a wide screen there is no top bar (the sidebar carries the menu), so the bell gets a slim one of its own. */}
        <div className="sticky top-0 z-20 hidden h-14 items-center gap-2 border-b border-slate-200 bg-white/95 px-6 backdrop-blur lg:flex print:hidden">
          <p className="text-sm font-medium text-slate-500">{today}</p>
          <div className="ml-auto flex items-center gap-2">
            {count > 0 && (
              <Link
                to="/orders"
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-brand-50 px-3 text-xs font-semibold text-brand-800 ring-1 ring-inset ring-brand-200 hover:bg-brand-100"
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-brand-500" />
                {count} live {count === 1 ? 'order' : 'orders'}
              </Link>
            )}
            <SoundToggle pill />
            <NotificationBell open={notificationsOpen} onOpen={() => setNotificationsOpen((v) => !v)} />
          </div>
        </div>

        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-5 outline-none sm:px-6 sm:py-8 print:max-w-none print:p-0">
          <div key={location.pathname} className="animate-fade-in">
            <RequestsBanner />
            <Outlet />
          </div>
        </main>
      </div>
      {notificationsOpen && <NotificationsPanel onClose={() => setNotificationsOpen(false)} />}
    </div>
  );
}

export default function AppShell() {
  return (
    <LiveOrdersProvider>
      <SidePanelProvider>
        <Shell />
      </SidePanelProvider>
    </LiveOrdersProvider>
  );
}

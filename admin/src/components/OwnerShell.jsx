import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { buttonClass } from '../pages/owner/ui.jsx';
import { ChevronRightIcon, LogoMark, LogoutIcon } from './icons.jsx';
import { cx } from '../lib/cx.js';

// "Restaurants" stays lit on a restaurant's own page too.
const NAV = [
  { to: '/owner', label: 'Restaurants', lit: (path) => path === '/owner' || path.startsWith('/owner/restaurants') },
  { to: '/owner/activity', label: 'Activity', lit: (path) => path.startsWith('/owner/activity') },
];

function OwnerNav({ className }) {
  const { pathname } = useLocation();
  return (
    <nav aria-label="Owner" className={cx('items-center gap-1', className)}>
      {NAV.map((n) => {
        const lit = n.lit(pathname);
        return (
          <NavLink
            key={n.to}
            to={n.to}
            aria-current={lit ? 'page' : undefined}
            className={cx('inline-flex h-8 items-center rounded-lg px-3 text-[0.875rem] font-semibold transition-colors', lit ? 'k-fill k-l1' : 'k-l2 hover:opacity-70')}
          >
            {n.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

/**
 * The owner console: a place of its own for the person who runs the whole product (every restaurant, suspend / reactivate). It is
 * deliberately not part of a restaurant's admin: another layout and an "Owner" mark, so it is never mistaken for one.
 * The owner signs in with their usual account (the one listed in SUPER_ADMIN_EMAILS) and switches between the two with a link on each side.
 * Anybody else is sent back to their restaurant admin (and the API refuses them anyway).
 */
export default function OwnerShell() {
  const { vendor, logout } = useAuth();
  if (!vendor?.is_super_admin) return <Navigate to="/" replace />;

  return (
    <div className="sys min-h-dvh" data-look="light">
      <header className="k-bar sticky top-0 z-30">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link to="/owner" className="flex items-center gap-2">
            <LogoMark size={26} />
            <span className="text-[0.9375rem] font-semibold tracking-[-0.01em]">MezMitra</span>
            <span className="k-l2 text-[0.75rem] font-semibold uppercase tracking-wider">Owner</span>
          </Link>

          <OwnerNav className="ml-2 hidden sm:flex" />

          <div className="ml-auto flex items-center gap-1">
            <span className="k-l3 mr-1 hidden max-w-56 truncate text-[0.8125rem] md:block" title={vendor.email}>
              {vendor.email}
            </span>
            <Link to="/" className={cx(buttonClass.link, 'gap-0.5')}>
              <span className="max-w-40 truncate">{vendor.name} admin</span>
              <ChevronRightIcon size={15} />
            </Link>
            <button type="button" onClick={logout} aria-label="Sign out" title="Sign out" className="k-l2 relative inline-flex size-9 items-center justify-center rounded-lg transition before:absolute before:-inset-1 before:content-[''] active:opacity-60">
              <LogoutIcon size={18} />
            </button>
          </div>
        </div>
        {/* On a phone the header has no room for the links, so they get a row of their own. */}
        <OwnerNav className="mx-auto flex w-full max-w-6xl px-3 pb-2 sm:hidden" />
      </header>

      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-6 outline-none sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}

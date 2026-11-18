import { Link, Navigate, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { ChevronRightIcon, LogoMark, LogoutIcon } from './icons.jsx';

/**
 * The owner console: a place of its own for the person who runs the whole product (every restaurant, suspend / reactivate). It is
 * deliberately not part of a restaurant's admin: another layout, a dark header and an "Owner" mark, so it is never mistaken for one.
 * The owner signs in with their usual account (the one listed in SUPER_ADMIN_EMAILS) and switches between the two with a link on each side.
 * Anybody else is sent back to their restaurant admin (and the API refuses them anyway).
 */
export default function OwnerShell() {
  const { vendor, logout } = useAuth();
  if (!vendor?.is_super_admin) return <Navigate to="/" replace />;

  return (
    <div className="min-h-dvh bg-slate-100">
      <header className="bg-slate-900 text-white">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to="/owner" className="flex min-w-0 items-center gap-2.5 rounded-lg">
            <LogoMark size={30} />
            <span className="text-base font-bold tracking-tight">
              Mez<span className="text-brand-400">Mitra</span>
            </span>
            <span className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-brand-200 ring-1 ring-inset ring-white/20">Owner</span>
          </Link>

          <nav aria-label="Owner" className="ml-3 hidden items-center sm:flex">
            <NavLink
              to="/owner"
              className={({ isActive }) =>
                `inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold transition-colors ${
                  isActive ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              Restaurants
            </NavLink>
          </nav>

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <span className="mr-1 hidden max-w-56 truncate text-xs text-slate-400 md:block" title={vendor.email}>
              {vendor.email}
            </span>
            <Link
              to="/"
              className="inline-flex h-9 items-center gap-1 rounded-lg bg-white/10 px-3 text-sm font-semibold text-white ring-1 ring-inset ring-white/15 hover:bg-white/20"
            >
              <span className="sm:hidden">Admin</span>
              <span className="hidden max-w-48 truncate sm:inline">{vendor.name} admin</span>
              <ChevronRightIcon size={16} />
            </Link>
            <button
              type="button"
              onClick={logout}
              aria-label="Sign out"
              title="Sign out"
              className="inline-flex size-9 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white"
            >
              <LogoutIcon size={18} />
            </button>
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-5 outline-none sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}

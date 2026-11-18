import { useAuth } from '../context/AuthContext.jsx';
import { auth } from '../lib/auth.js';
import { ShieldIcon } from './icons.jsx';

/**
 * Shown on every page while the platform owner is "logged in as" a restaurant (the API marks that session). It says so plainly and
 * has the way back: the owner's own session was kept aside, so one click returns to the owner console.
 */
export default function ImpersonationBar() {
  const { vendor, logout } = useAuth();
  if (!vendor?.impersonated_by_owner) return null;

  const back = () => {
    if (auth.returnToOwner()) window.location.assign('/owner');
    else logout();
  };

  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-slate-900 px-4 py-2 text-sm text-white print:hidden">
      <ShieldIcon size={16} className="shrink-0 text-brand-300" />
      <p className="min-w-0 flex-1">
        You are viewing <strong className="font-semibold">{vendor.name}</strong> as the platform owner. What you change here is real.
      </p>
      <button
        type="button"
        onClick={back}
        className="inline-flex h-8 items-center rounded-lg bg-white px-3 text-sm font-semibold text-slate-900 hover:bg-slate-100"
      >
        Back to owner console
      </button>
    </div>
  );
}

import { cx } from '../lib/cx.js';
import { AlertIcon, CheckCircleIcon, InfoIcon } from './icons.jsx';
import { Button } from './Button.jsx';

export function EmptyState({ icon: Icon, title, message, action, className = '' }) {
  return (
    <div className={cx('flex flex-col items-center px-6 py-14 text-center', className)}>
      {Icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          <Icon size={24} />
        </div>
      )}
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {message && <p className="mt-1 max-w-sm text-sm text-slate-500">{message}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Shown when a request fails and there is nothing (valid) to display. `error.message` is safe to show. */
export function ErrorState({ error, onRetry, title = 'Something went wrong', className = '' }) {
  return (
    <div role="alert" className={cx('flex flex-col items-center px-6 py-14 text-center', className)}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-red-50 text-red-600">
        <AlertIcon size={24} />
      </div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-slate-500">{error?.message || 'Please try again.'}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Inline banner for errors/warnings/info inside forms and dialogs. */
export function Alert({ tone = 'error', children, className = '', role }) {
  const tones = {
    error: 'border-red-200 bg-red-50 text-red-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  };
  const Icon = tone === 'info' ? InfoIcon : tone === 'success' ? CheckCircleIcon : AlertIcon;
  return (
    <div role={role ?? (tone === 'error' ? 'alert' : 'status')} className={cx('flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm', tones[tone], className)}>
      <Icon size={18} className="mt-0.5" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

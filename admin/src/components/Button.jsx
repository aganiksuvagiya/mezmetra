import { cx } from '../lib/cx.js';
import { Spinner } from './Spinner.jsx';

const base =
  'inline-flex items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors disabled:opacity-60 disabled:cursor-not-allowed';

const variants = {
  primary: 'bg-brand-600 text-white shadow-xs hover:bg-brand-700 active:bg-brand-800',
  secondary: 'border border-slate-300 bg-white text-slate-700 shadow-xs hover:bg-slate-50 active:bg-slate-100',
  danger: 'bg-red-600 text-white shadow-xs hover:bg-red-700 active:bg-red-800',
  'danger-outline': 'border border-red-200 bg-white text-red-700 hover:bg-red-50 active:bg-red-100',
  ghost: 'text-slate-600 hover:bg-slate-100 active:bg-slate-200',
};

const sizes = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-11 px-5 text-base',
};

/** Shows a spinner and is disabled while `busy`, so a second click can never fire another request. */
export function Button({ variant = 'primary', size = 'md', busy = false, disabled = false, icon: Icon, className = '', children, type = 'button', ...rest }) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(base, variants[variant], sizes[size], className)}
      {...rest}
    >
      {busy ? <Spinner /> : Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}

const iconVariants = {
  default: 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 active:bg-slate-200',
  danger: 'text-slate-500 hover:bg-red-50 hover:text-red-700 active:bg-red-100',
  brand: 'text-slate-500 hover:bg-brand-50 hover:text-brand-700 active:bg-brand-100',
  starOn: 'text-amber-500 hover:bg-amber-50 active:bg-amber-100',
};

export function IconButton({ label, icon: Icon, variant = 'default', busy = false, disabled = false, className = '', ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex size-10 items-center justify-center rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed sm:size-9',
        iconVariants[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner /> : <Icon size={18} />}
    </button>
  );
}

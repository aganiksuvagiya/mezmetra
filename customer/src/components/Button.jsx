import { Link } from 'react-router-dom';
import { SpinnerIcon } from './Icons';

const base =
  'inline-flex min-h-11 select-none items-center justify-center gap-2 rounded-2xl px-5 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

const variants = {
  primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700 active:bg-brand-800 disabled:hover:bg-brand-600',
  secondary: 'bg-white text-brand-700 ring-1 ring-inset ring-line hover:bg-brand-50 active:bg-brand-100',
  ghost: 'text-brand-700 hover:bg-brand-50 active:bg-brand-100',
  danger: 'text-rose-700 hover:bg-rose-50 active:bg-rose-100',
};

export const buttonClass = ({ variant = 'primary', block = false, className = '' } = {}) =>
  [base, variants[variant], block ? 'w-full' : '', className].filter(Boolean).join(' ');

export function Button({ variant, block, className, loading = false, disabled, children, type = 'button', ...rest }) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, block, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <SpinnerIcon />}
      {children}
    </button>
  );
}

export function LinkButton({ to, variant, block, className, children, ...rest }) {
  return (
    <Link to={to} className={buttonClass({ variant, block, className })} {...rest}>
      {children}
    </Link>
  );
}

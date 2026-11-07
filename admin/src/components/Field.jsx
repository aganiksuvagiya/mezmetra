import { useId, useState } from 'react';
import { cx } from '../lib/cx.js';
import { ChevronDownIcon, EyeIcon, EyeOffIcon, SearchIcon, CloseIcon } from './icons.jsx';
import { Spinner } from './Spinner.jsx';

const controlBase =
  'block w-full rounded-lg border bg-white px-3 text-base text-slate-900 shadow-xs placeholder:text-slate-400 sm:text-sm ' +
  'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-600 ' +
  'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500';

const controlBorder = (error) => (error ? 'border-red-500' : 'border-slate-300 hover:border-slate-400');

function Shell({ id, label, hint, error, required, labelHidden, className, children }) {
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className={labelHidden ? 'sr-only' : 'mb-1.5 block text-sm font-medium text-slate-700'}>
          {label}
          {required && (
            <span aria-hidden="true" className="text-red-600">
              {' '}
              *
            </span>
          )}
        </label>
      )}
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="mt-1.5 text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function ariaFor(id, error, hint, required) {
  return {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-err` : hint ? `${id}-hint` : undefined,
    'aria-required': required || undefined,
  };
}

export function Input({ label, hint, error, required, labelHidden, wrapperClassName, className, prefix, suffix, ...props }) {
  const autoId = useId();
  const id = props.id ?? autoId;
  return (
    <Shell id={id} label={label} hint={hint} error={error} required={required} labelHidden={labelHidden} className={wrapperClassName}>
      <div className="relative">
        {prefix && <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-slate-500">{prefix}</span>}
        <input
          {...props}
          {...ariaFor(id, error, hint, required)}
          className={cx(controlBase, 'h-10', controlBorder(error), prefix && (String(prefix).length > 2 ? 'pl-11' : 'pl-7'), suffix && 'pr-10', className)}
        />
        {suffix && <span className="absolute inset-y-0 right-1 flex items-center">{suffix}</span>}
      </div>
    </Shell>
  );
}

export function PasswordInput({ label, hint, error, required, wrapperClassName, className, ...props }) {
  const [visible, setVisible] = useState(false);
  return (
    <Input
      {...props}
      label={label}
      hint={hint}
      error={error}
      required={required}
      wrapperClassName={wrapperClassName}
      className={className}
      type={visible ? 'text' : 'password'}
      suffix={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="inline-flex size-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
        >
          {visible ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
        </button>
      }
    />
  );
}

export function Textarea({ label, hint, error, required, labelHidden, wrapperClassName, className, rows = 3, ...props }) {
  const autoId = useId();
  const id = props.id ?? autoId;
  return (
    <Shell id={id} label={label} hint={hint} error={error} required={required} labelHidden={labelHidden} className={wrapperClassName}>
      <textarea {...props} rows={rows} {...ariaFor(id, error, hint, required)} className={cx(controlBase, 'py-2', controlBorder(error), className)} />
    </Shell>
  );
}

export function Select({ label, hint, error, required, labelHidden, wrapperClassName, className, children, ...props }) {
  const autoId = useId();
  const id = props.id ?? autoId;
  return (
    <Shell id={id} label={label} hint={hint} error={error} required={required} labelHidden={labelHidden} className={wrapperClassName}>
      <div className="relative">
        <select {...props} {...ariaFor(id, error, hint, required)} className={cx(controlBase, 'h-10 appearance-none pr-9', controlBorder(error), className)}>
          {children}
        </select>
        <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
      </div>
    </Shell>
  );
}

/** Search box with a magnifier, a clear button and a pending indicator. */
export function SearchInput({ value, onChange, placeholder = 'Search', label = 'Search', pending = false, maxLength = 80, className }) {
  const id = useId();
  return (
    <div className={cx('relative', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <SearchIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        maxLength={maxLength}
        className={cx(controlBase, 'h-10 pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden', controlBorder(false))}
      />
      <span className="absolute inset-y-0 right-1.5 flex items-center">
        {pending ? (
          <Spinner className="mr-1.5 text-slate-400" />
        ) : (
          value && (
            <button type="button" onClick={() => onChange('')} aria-label="Clear search" className="inline-flex size-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <CloseIcon size={14} />
            </button>
          )
        )}
      </span>
    </div>
  );
}

/** Accessible on/off switch (a button with role="switch"). Use `label` for a visible label or `ariaLabel` alone. */
export function Switch({ checked, onChange, ariaLabel, id, disabled = false, busy = false, className }) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 disabled:cursor-not-allowed',
        checked ? 'bg-brand-600' : 'bg-slate-300',
        className,
      )}
    >
      <span aria-hidden="true" className={cx('inline-flex size-5 items-center justify-center rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[22px]' : 'translate-x-0.5')}>
        {busy && <Spinner size={12} className="text-slate-500" />}
      </span>
    </button>
  );
}

/** A switch with a visible label and optional description, in a row. Clicking the label toggles it. */
export function SwitchField({ label, description, checked, onChange, disabled = false, className }) {
  const id = useId();
  return (
    <div className={cx('flex items-start justify-between gap-4', className)}>
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-slate-500">{description}</span>}
      </label>
      <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function Checkbox({ label, checked, onChange, disabled = false, className }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx('inline-flex items-center gap-2 text-sm text-slate-700', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded border-slate-300 accent-brand-600"
      />
      {label}
    </label>
  );
}

/** Moves keyboard focus to the first field marked invalid inside `form` (call after setting errors). */
export function focusFirstInvalid(form) {
  requestAnimationFrame(() => form?.querySelector('[aria-invalid="true"]')?.focus());
}

import { MinusIcon, PlusIcon } from './Icons';
import { MAX_QTY } from '../lib/cart';

/** − 2 + stepper. `label` names the dish for screen readers ("Decrease quantity of Margherita Pizza"). */
export default function QuantityStepper({ value, onChange, min = 1, max = MAX_QTY, label = '', className = '' }) {
  const btn =
    'grid size-11 place-items-center rounded-full bg-white text-brand-700 ring-1 ring-inset ring-line transition-colors hover:bg-brand-50 active:bg-brand-100 disabled:cursor-not-allowed disabled:text-ink-soft/50 disabled:hover:bg-white';
  return (
    <div role="group" aria-label={label ? `Quantity of ${label}` : 'Quantity'} className={`inline-flex items-center gap-1 ${className}`}>
      <button
        type="button"
        className={btn}
        onClick={() => onChange(value - 1)}
        disabled={value <= min}
        aria-label={label ? `Decrease quantity of ${label}` : 'Decrease quantity'}
      >
        <MinusIcon />
      </button>
      <span aria-live="polite" aria-atomic="true" className="min-w-8 text-center text-base font-bold tabular-nums">
        {value}
      </span>
      <button
        type="button"
        className={btn}
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label={label ? `Increase quantity of ${label}` : 'Increase quantity'}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

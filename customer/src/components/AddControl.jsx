import { MinusIcon, PlusIcon } from './Icons';
import { MAX_QTY } from '../lib/cart';

/**
 * The control on a dish:
 *  - not in the cart            -> a round "+" (one tap adds it, or opens the sheet for dishes with choices)
 *  - plain dish already in cart -> an inline "- n +" stepper pill
 *  - dish with choices          -> the round "+" with a count badge when some are already in the cart
 * It sits above the card's "stretched" button, so it re-enables pointer events itself.
 * tone="light" is a white control for use over photos; tone="solid" is the default on white rows. compact is a small "+" square for dense lists.
 */
export default function AddControl({ item, plainQty = 0, totalQty = 0, hasOptions, onQuickAdd, onStep, onOpen, tone = 'solid', compact = false }) {
  const label = item.name;

  if (item.is_sold_out) {
    return (
      <span
        className={`pointer-events-auto relative z-10 inline-flex h-8 items-center rounded-chip px-3 text-xs font-extrabold uppercase tracking-wide ${
          tone === 'light' ? 'bg-black/55 text-white backdrop-blur-sm' : 'bg-ink/10 text-ink-soft'
        }`}
      >
        Sold out
      </span>
    );
  }

  if (!hasOptions && plainQty > 0) {
    return (
      <div
        role="group"
        aria-label={`Quantity of ${label}`}
        className={`pointer-events-auto relative z-10 inline-flex h-9 min-w-[5.75rem] items-center justify-between rounded-chip px-0.5 motion-safe:animate-pop ${
          tone === 'light' ? 'text-brand-700' : 'text-link'
        } ${
          tone === 'light' ? 'bg-white shadow-dock' : 'bg-page ring-1 ring-inset ring-line'
        }`}
      >
        <button
          type="button"
          onClick={() => onStep(item, plainQty - 1)}
          aria-label={`Decrease quantity of ${label}`}
          className="grid size-8 place-items-center rounded-chip hover:bg-fill active:bg-fill-strong"
        >
          <MinusIcon className="size-4" />
        </button>
        <span aria-live="polite" aria-atomic="true" className={`min-w-5 text-center text-[15px] font-bold tabular-nums ${tone === 'light' ? 'text-slate-900' : 'text-ink'}`}>
          {plainQty}
        </span>
        <button
          type="button"
          onClick={() => onStep(item, plainQty + 1)}
          disabled={plainQty >= MAX_QTY}
          aria-label={`Increase quantity of ${label}`}
          className="grid size-8 place-items-center rounded-chip hover:bg-fill active:bg-fill-strong disabled:opacity-40"
        >
          <PlusIcon className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <span className="pointer-events-auto relative z-10 inline-flex">
      <button
        type="button"
        onClick={() => (hasOptions ? onOpen(item) : onQuickAdd(item))}
        aria-label={hasOptions ? `Choose options for ${label}` : `Add ${label}`}
        className={`inline-flex h-9 items-center justify-center gap-1 rounded-chip text-[15px] font-bold uppercase tracking-wide transition-transform active:scale-95 ${
          tone === 'light' ? 'text-brand-700' : 'text-link'
        } ${
          compact ? 'w-9' : 'min-w-[5rem] px-4'
        } ${tone === 'light' ? 'bg-white/95 shadow-dock backdrop-blur' : 'bg-page ring-1 ring-inset ring-line'}`}
      >
        {compact ? <span className="sr-only">Add</span> : 'Add'}
        <PlusIcon className={compact ? 'size-4' : 'size-3.5'} />
      </button>
      {totalQty > 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-1.5 -top-2 z-20 grid h-5 min-w-5 place-items-center rounded-chip bg-brand-600 px-1 text-[11px] font-extrabold leading-none text-white ring-2 ring-card"
        >
          {totalQty}
        </span>
      )}
    </span>
  );
}

import AddControl from './AddControl';
import DishImage from './DishImage';
import { SparkIcon } from './Icons';
import { formatMoney } from '../lib/money';

/**
 * One dish as a row inside a grouped list. The whole row opens the details sheet (the dish name is a "stretched"
 * button whose ::after covers the row); the add control is a second, separate control, so no interactive element is
 * nested inside another. Everything visual above the stretched button is pointer-events-none so taps fall through.
 */
export function DishCard({ item, plainQty = 0, totalQty = 0, onOpen, onQuickAdd, onStep }) {
  const hasOptions = (item.option_groups ?? []).length > 0;
  return (
    <article className="relative flex gap-4 p-4 has-[:focus-visible]:bg-brand-50/60">
      <div className={`flex min-w-0 flex-1 flex-col ${item.is_sold_out ? 'opacity-60' : ''}`}>
        <h3 className="text-[17px] font-bold leading-snug tracking-tight text-ink">
          <button type="button" onClick={() => onOpen(item)} className="text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">
            {item.name}
          </button>
        </h3>
        {item.description && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">{item.description}</p>}
        <div className="mt-auto flex flex-wrap items-baseline gap-x-2 pt-3">
          <p className="text-base font-extrabold tabular-nums text-ink">{formatMoney(item.price)}</p>
          {hasOptions && <span className="text-xs font-semibold text-brand-700">Customisable</span>}
        </div>
      </div>

      <div className="pointer-events-none flex w-[6.25rem] shrink-0 flex-col items-center">
        <DishImage item={item} className={`size-[6.25rem] rounded-[22px] ${item.is_sold_out ? 'opacity-60 grayscale' : ''}`} iconClass="size-11" />
        <div className="-mt-5">
          <AddControl item={item} plainQty={plainQty} totalQty={totalQty} hasOptions={hasOptions} onQuickAdd={onQuickAdd} onStep={onStep} onOpen={onOpen} />
        </div>
      </div>
    </article>
  );
}

/** A big picture card for the "Chef's picks" strip: white text over the photo (or a themed tile). */
export function PickCard({ item, plainQty = 0, totalQty = 0, onOpen, onQuickAdd, onStep }) {
  const hasOptions = (item.option_groups ?? []).length > 0;
  return (
    <article className="relative aspect-[5/6] w-[68%] max-w-[16.5rem] shrink-0 snap-start overflow-hidden rounded-[28px] text-white shadow-soft has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand-800">
      <DishImage item={item} variant="hero" className={`pointer-events-none absolute inset-0 size-full ${item.is_sold_out ? 'grayscale' : ''}`} iconClass="size-28" />
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/75 via-black/30 to-transparent" />

      <span className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-black/35 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 ring-inset ring-white/25 backdrop-blur-md">
        <SparkIcon className="size-3.5" />
        Chef&apos;s pick
      </span>

      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-4">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-lg font-bold leading-tight tracking-tight">
            <button type="button" onClick={() => onOpen(item)} className="text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">
              {item.name}
            </button>
          </h3>
          <p className="mt-1 text-[15px] font-extrabold tabular-nums text-white/95">{formatMoney(item.price)}</p>
        </div>
        <div className="pointer-events-none shrink-0">
          <AddControl item={item} plainQty={plainQty} totalQty={totalQty} hasOptions={hasOptions} onQuickAdd={onQuickAdd} onStep={onStep} onOpen={onOpen} tone="light" />
        </div>
      </div>
    </article>
  );
}

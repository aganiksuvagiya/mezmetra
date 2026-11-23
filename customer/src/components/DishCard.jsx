import AddControl from './AddControl';
import DietMark from './DietMark';
import DishImage from './DishImage';
import { SparkIcon } from './Icons';
import { formatMoney } from '../lib/money';
import { useDesign } from '../lib/theme';

/*
 * One dish, drawn the way the restaurant's chosen design lays dishes out (shared/styles.js `list`):
 *   rows     a white row with the photo at the right (Classic)
 *   menu     a printed-menu line: the name, a dotted line, the price (Bistro)
 *   grid     a photo card, two to a row (Gallery)
 *   compact  a dense text line with a small "+" (Minimal)
 *   stack    one big photo card per dish (Night)
 * In every layout the whole card opens the details sheet (the dish name is a "stretched" button whose ::after covers the
 * card); the add control is a second, separate control, so no interactive element is nested inside another. Everything visual
 * above the stretched button is pointer-events-none so taps fall through.
 */

const stretched = "text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none";

function RowCard({ item, plainQty, totalQty, onOpen, onQuickAdd, onStep }) {
  const hasOptions = (item.option_groups ?? []).length > 0;
  return (
    <article className="relative flex gap-4 p-4 has-[:focus-visible]:bg-tint/60">
      <div className={`flex min-w-0 flex-1 flex-col ${item.is_sold_out ? 'opacity-60' : ''}`}>
        <h3 className="text-[17px] font-bold leading-snug tracking-tight text-ink">
          <DietMark diet={item.diet} size={15} className="mr-1.5 -translate-y-px" />
          <button type="button" onClick={() => onOpen(item)} className={stretched}>
            {item.name}
          </button>
        </h3>
        {item.description && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">{item.description}</p>}
        <div className="mt-auto flex flex-wrap items-baseline gap-x-2 pt-3">
          <p className="text-base font-extrabold tabular-nums text-ink">{formatMoney(item.price)}</p>
          {hasOptions && <span className="text-xs font-semibold text-link">Customisable</span>}
        </div>
      </div>

      <div className="pointer-events-none flex w-[6.25rem] shrink-0 flex-col items-center">
        <DishImage item={item} className={`size-[6.25rem] rounded-[18px] ${item.is_sold_out ? 'opacity-60 grayscale' : ''}`} iconClass="size-11" />
        <div className="-mt-5">
          <AddControl item={item} plainQty={plainQty} totalQty={totalQty} hasOptions={hasOptions} onQuickAdd={onQuickAdd} onStep={onStep} onOpen={onOpen} />
        </div>
      </div>
    </article>
  );
}

function MenuLine({ item, plainQty, totalQty, onOpen, onQuickAdd, onStep }) {
  const hasOptions = (item.option_groups ?? []).length > 0;
  return (
    <article className="relative flex gap-3.5 py-4 has-[:focus-visible]:bg-tint/60">
      <div className={`min-w-0 flex-1 ${item.is_sold_out ? 'opacity-60' : ''}`}>
        <h3 className="flex items-baseline gap-2 text-[17px] font-semibold leading-snug text-ink">
          <span className="min-w-0">
            <DietMark diet={item.diet} size={14} className="mr-1.5 -translate-y-px" />
            <button type="button" onClick={() => onOpen(item)} className={stretched}>
              {item.name}
            </button>
          </span>
          <span aria-hidden="true" className="min-w-4 flex-1 translate-y-[-3px] border-b border-dotted border-ink-soft/60" />
          <span className="shrink-0 tabular-nums">{formatMoney(item.price)}</span>
        </h3>
        {item.description && <p className="mt-1 line-clamp-2 text-[13px] italic leading-relaxed text-ink-soft">{item.description}</p>}
        <div className="pointer-events-none mt-2.5 flex items-center gap-3">
          <AddControl item={item} plainQty={plainQty} totalQty={totalQty} hasOptions={hasOptions} onQuickAdd={onQuickAdd} onStep={onStep} onOpen={onOpen} />
          {hasOptions && <span className="text-xs italic text-link">with choices</span>}
        </div>
      </div>
      <DishImage item={item} className={`pointer-events-none size-[4.75rem] shrink-0 self-start rounded-md ${item.is_sold_out ? 'opacity-60 grayscale' : ''}`} iconClass="size-8" />
    </article>
  );
}

function GridCard({ item, plainQty, totalQty, onOpen, onQuickAdd, onStep }) {
  const hasOptions = (item.option_groups ?? []).length > 0;
  return (
    <article className="relative flex min-w-0 flex-col has-[:focus-visible]:rounded-2xl has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-600">
      <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-fill">
        <DishImage item={item} className={`pointer-events-none size-full ${item.is_sold_out ? 'opacity-60 grayscale' : ''}`} iconClass="size-12" />
        {item.diet && (
          <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-white p-0.5 shadow-sm">
            <DietMark diet={item.diet} size={14} />
          </span>
        )}
        <div className="pointer-events-none absolute bottom-2 right-2">
          <AddControl item={item} plainQty={plainQty} totalQty={totalQty} hasOptions={hasOptions} onQuickAdd={onQuickAdd} onStep={onStep} onOpen={onOpen} tone="light" compact />
        </div>
      </div>
      <div className={`px-0.5 pt-2 ${item.is_sold_out ? 'opacity-60' : ''}`}>
        <h3 className="text-[15px] font-bold leading-snug text-ink">
          <button type="button" onClick={() => onOpen(item)} className={stretched}>
            {item.name}
          </button>
        </h3>
        {item.description && <p className="line-clamp-1 text-xs text-ink-soft">{item.description}</p>}
        <p className="mt-0.5 text-[15px] font-extrabold tabular-nums text-ink">
          {formatMoney(item.price)}
          {hasOptions && <span className="ml-1.5 text-[11px] font-semibold text-link">Customisable</span>}
        </p>
      </div>
    </article>
  );
}

function CompactLine({ item, plainQty, totalQty, onOpen, onQuickAdd, onStep }) {
  const hasOptions = (item.option_groups ?? []).length > 0;
  return (
    <article className="relative flex items-center gap-3 py-2.5 has-[:focus-visible]:bg-tint/60">
      <div className={`min-w-0 flex-1 ${item.is_sold_out ? 'opacity-60' : ''}`}>
        <h3 className="text-[15px] font-semibold leading-snug text-ink">
          <DietMark diet={item.diet} size={13} className="mr-1.5 -translate-y-px" />
          <button type="button" onClick={() => onOpen(item)} className={stretched}>
            {item.name}
          </button>
        </h3>
        {item.description && <p className="line-clamp-1 text-xs text-ink-soft">{item.description}</p>}
      </div>
      <p className={`shrink-0 text-[15px] font-semibold tabular-nums text-ink ${item.is_sold_out ? 'opacity-60' : ''}`}>{formatMoney(item.price)}</p>
      <div className="pointer-events-none shrink-0">
        <AddControl item={item} plainQty={plainQty} totalQty={totalQty} hasOptions={hasOptions} onQuickAdd={onQuickAdd} onStep={onStep} onOpen={onOpen} compact />
      </div>
    </article>
  );
}

function StackCard({ item, plainQty, totalQty, onOpen, onQuickAdd, onStep }) {
  const hasOptions = (item.option_groups ?? []).length > 0;
  return (
    <article className="surface relative overflow-hidden has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500">
      <div className="relative aspect-[16/9] bg-fill">
        <DishImage item={item} className={`pointer-events-none size-full ${item.is_sold_out ? 'opacity-60 grayscale' : ''}`} iconClass="size-16" />
        {item.diet && (
          <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-white p-0.5 shadow-sm">
            <DietMark diet={item.diet} size={16} />
          </span>
        )}
      </div>
      <div className={`flex items-end justify-between gap-3 p-3.5 ${item.is_sold_out ? 'opacity-60' : ''}`}>
        <div className="min-w-0">
          <h3 className="text-[17px] font-bold leading-snug tracking-tight text-ink">
            <button type="button" onClick={() => onOpen(item)} className={stretched}>
              {item.name}
            </button>
          </h3>
          {item.description && <p className="mt-0.5 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">{item.description}</p>}
          <p className="mt-1.5 text-base font-extrabold tabular-nums text-link">
            {formatMoney(item.price)}
            {hasOptions && <span className="ml-2 text-xs font-semibold text-ink-soft">Customisable</span>}
          </p>
        </div>
        <div className="pointer-events-none shrink-0">
          <AddControl item={item} plainQty={plainQty} totalQty={totalQty} hasOptions={hasOptions} onQuickAdd={onQuickAdd} onStep={onStep} onOpen={onOpen} />
        </div>
      </div>
    </article>
  );
}

const CARDS = { rows: RowCard, menu: MenuLine, grid: GridCard, compact: CompactLine, stack: StackCard };

/** One dish in the layout of the current design. */
export function DishCard({ plainQty = 0, totalQty = 0, ...rest }) {
  const { list } = useDesign();
  const Card = CARDS[list] ?? RowCard;
  return <Card plainQty={plainQty} totalQty={totalQty} {...rest} />;
}

const CONTAINERS = {
  rows: 'surface mt-4 overflow-hidden',
  menu: 'mt-2 divide-y divide-line border-y border-line',
  grid: 'mt-4 grid grid-cols-2 gap-x-3 gap-y-5',
  compact: 'mt-2 divide-y divide-line border-y border-line',
  stack: 'mt-4 space-y-3',
};

/**
 * The dishes of one category (or the search results) in the current design: a white grouped list, printed-menu lines, a photo
 * grid, a dense list or a stack of big cards. `cardProps(item)` gives each card what it needs.
 */
export function DishList({ items, cardProps }) {
  const { list } = useDesign();
  return (
    <ul className={CONTAINERS[list] ?? CONTAINERS.rows}>
      {items.map((item) => (
        <li
          key={item.id}
          className={list === 'rows' ? 'relative before:pointer-events-none before:absolute before:left-4 before:right-0 before:top-0 before:h-px before:bg-line first:before:hidden' : 'relative'}
        >
          <DishCard {...cardProps(item)} />
        </li>
      ))}
    </ul>
  );
}

/** A big picture card for the "Chef's picks" strip: white text over the photo (or a themed tile). */
export function PickCard({ item, plainQty = 0, totalQty = 0, onOpen, onQuickAdd, onStep }) {
  const hasOptions = (item.option_groups ?? []).length > 0;
  return (
    <article className="relative aspect-[6/7] w-[68%] max-w-[16.5rem] shrink-0 snap-start overflow-hidden rounded-3xl text-white shadow-soft has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand-800">
      <DishImage item={item} variant="hero" className={`pointer-events-none absolute inset-0 size-full ${item.is_sold_out ? 'grayscale' : ''}`} iconClass="size-28" />
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/75 via-black/30 to-transparent" />

      <span className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1 rounded-chip bg-black/35 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 ring-inset ring-white/25 backdrop-blur-md">
        <SparkIcon className="size-3.5" />
        Chef&apos;s pick
      </span>
      {item.diet && (
        <span className="pointer-events-none absolute right-3 top-3 rounded-md bg-white p-0.5 shadow-sm">
          <DietMark diet={item.diet} size={18} />
        </span>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-4">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-lg font-bold leading-tight tracking-tight">
            <button type="button" onClick={() => onOpen(item)} className={stretched}>
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DIET_LABELS } from '../components/DietMark';
import { DishList, PickCard } from '../components/DishCard';
import EmptyState from '../components/EmptyState';
import { Button } from '../components/Button';
import { ChevronRightIcon, CloseIcon, MenuBookIcon, SearchIcon } from '../components/Icons';
import ItemSheet from '../components/ItemSheet';
import RecentOrders from '../components/RecentOrders';
import VendorMark from '../components/VendorMark';
import { useToast } from '../components/Toast';
import { buildLine, lineKey, MAX_LINES, MAX_QTY } from '../lib/cart';
import { useActiveOrder } from '../lib/useActiveOrder';
import { useRecentOrders } from '../lib/useRecentOrders';
import { useDesign } from '../lib/theme';
import { useTable } from '../lib/tableContext';
import { usePageTitle } from '../lib/usePageTitle';
import { formatMoney } from '../lib/money';

const ORDER_STATUS_TEXT = {
  pending: 'Received - waiting for the kitchen',
  accepted: 'Being prepared',
  ready: 'Ready - on its way to your table',
  completed: 'Served - payment is still due',
};

// Height of the sticky category bar (plus a little air): where a section "starts" when it counts as the current one.
const NAV_OFFSET = 96;

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** A category's heading, in the style of the restaurant's design (printed-menu rules, small caps, or a big title). */
function SectionTitle({ id, name, count, description }) {
  const { id: style } = useDesign();
  if (style === 'bistro') {
    return (
      <>
        <h2 id={id} className="flex items-center gap-3 text-[15px] font-semibold uppercase tracking-[0.22em] text-ink before:h-px before:flex-1 before:bg-ink-soft/40 after:h-px after:flex-1 after:bg-ink-soft/40">
          {name}
        </h2>
        {description && <p className="mt-1 text-center text-sm italic text-ink-soft">{description}</p>}
      </>
    );
  }
  if (style === 'minimal') {
    return (
      <>
        <h2 id={id} className="flex items-baseline gap-2 border-b-2 border-ink pb-1.5 text-xs font-bold uppercase tracking-[0.16em] text-ink">
          {name}
          {count != null && <span className="font-semibold text-ink-soft">{count}</span>}
        </h2>
        {description && <p className="mt-1 text-xs text-ink-soft">{description}</p>}
      </>
    );
  }
  return (
    <>
      <h2 id={id} className="display flex items-baseline gap-2 px-1 text-2xl font-extrabold text-ink">
        {name}
        {count != null && <span className="text-sm font-semibold tracking-normal text-ink-soft">{count}</span>}
      </h2>
      {description && <p className="mt-0.5 px-1 text-sm text-ink-soft">{description}</p>}
    </>
  );
}

export default function MenuPage() {
  const { token, menu, cart } = useTable();
  const toast = useToast();
  const activeOrder = useActiveOrder(token);
  const recentOrders = useRecentOrders(menu.vendor.name);
  const [openItem, setOpenItem] = useState(null);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState(null);
  const chipScroller = useRef(null);
  usePageTitle(`Menu - ${menu.vendor.name}`);
  const design = useDesign();

  const { categories } = menu;
  const allItems = menu.items;

  // Veg / Egg / Non-veg / Jain filter. Only kinds this menu really has are offered, and only when some dishes are marked at all.
  // "Veg" also shows the Jain dishes (they are vegetarian too); a dish that is not marked never matches a filter.
  const [diet, setDiet] = useState('');
  const dietChips = useMemo(
    () => ['veg', 'egg', 'nonveg', 'jain'].filter((kind) => allItems.some((i) => i.diet === kind || (kind === 'veg' && i.diet === 'jain'))),
    [allItems],
  );
  const items = useMemo(
    () => (diet ? allItems.filter((i) => i.diet === diet || (diet === 'veg' && i.diet === 'jain')) : allItems),
    [allItems, diet],
  );

  // Quantities per dish: everything in the cart, and the "plain" line (no options / notes) that an inline stepper controls.
  const { totalQty, plainQty } = useMemo(() => {
    const total = new Map();
    const plain = new Map();
    for (const line of cart.lines) {
      total.set(line.itemId, (total.get(line.itemId) ?? 0) + line.quantity);
      if (line.key === lineKey(line.itemId, [], '')) plain.set(line.itemId, line.quantity);
    }
    return { totalQty: total, plainQty: plain };
  }, [cart.lines]);

  const picks = useMemo(() => items.filter((i) => i.is_featured), [items]);

  // The ways of paying this restaurant takes, shown under its name so nobody is surprised at the cart.
  const payChips = [
    ['razorpay', 'phonepe'].some((name) => menu.payment_options?.[name]) && { key: 'online', label: 'Card & online' },
    menu.payment_options?.cash && { key: 'cash', label: 'Pay at counter' },
  ].filter(Boolean);

  const sections = useMemo(() => {
    const grouped = categories
      .map((c) => ({ id: String(c.id), name: c.name, description: c.description, items: items.filter((i) => i.category_id === c.id) }))
      .filter((s) => s.items.length > 0);
    const known = new Set(categories.map((c) => c.id));
    const rest = items.filter((i) => !known.has(i.category_id));
    return rest.length ? [...grouped, { id: 'other', name: 'More dishes', description: '', items: rest }] : grouped;
  }, [categories, items]);

  const chips = useMemo(
    () => [...(picks.length ? [{ id: 'picks', name: 'Chef’s picks' }] : []), ...sections.map((s) => ({ id: s.id, name: s.name }))],
    [picks.length, sections],
  );
  const chipKey = chips.map((c) => c.id).join('|');

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const results = useMemo(
    () => (searching ? items.filter((i) => `${i.name} ${i.description ?? ''} ${i.category_name ?? ''}`.toLowerCase().includes(q)) : []),
    [items, q, searching],
  );

  // Scroll-spy: highlight the chip of the section that is currently under the sticky bar.
  useEffect(() => {
    if (searching || chips.length === 0) return undefined;
    const ids = chips.map((c) => c.id);
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(`sec-${id}`);
        if (el && el.getBoundingClientRect().top <= NAV_OFFSET) current = id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = ids[ids.length - 1];
      setActiveId(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chipKey stands in for the chips list
  }, [chipKey, searching]);

  // Keep the active chip visible inside the horizontal scroller.
  useEffect(() => {
    const scroller = chipScroller.current;
    const chip = scroller?.querySelector('[aria-current="true"]');
    if (!scroller || !chip) return;
    const target = chip.offsetLeft - (scroller.clientWidth - chip.offsetWidth) / 2;
    scroller.scrollTo({ left: Math.max(0, target), behavior: 'auto' });
  }, [activeId]);

  const jumpTo = (id) => {
    const el = document.getElementById(`sec-${id}`);
    if (!el) return;
    setActiveId(id);
    el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  };

  const fullMessage = `Your cart is full (${MAX_LINES} different dishes). Remove something to add more.`;

  // From the details sheet (options / notes): announce with a toast.
  const addFromSheet = (line) => {
    const result = cart.add(line);
    if (!result.ok) {
      toast.error(fullMessage);
      return false;
    }
    toast.success(`${line.quantity} × ${line.name} added to cart`);
    if (result.capped) toast.info(`You can order at most ${MAX_QTY} of one dish at a time.`);
    return true;
  };

  // One tap on ADD for a plain dish. The card's stepper and the cart bar are the feedback, so no toast.
  const quickAdd = (item) => {
    const result = cart.add(buildLine(item, [], 1, ''));
    if (!result.ok) toast.error(fullMessage);
    else navigator.vibrate?.(8);
  };

  const step = (item, next) => {
    const key = lineKey(item.id, [], '');
    if (next <= 0) cart.remove(key);
    else if (next <= MAX_QTY) cart.setQuantity(key, next);
  };

  const cardProps = (item) => ({
    item,
    plainQty: plainQty.get(item.id) ?? 0,
    totalQty: totalQty.get(item.id) ?? 0,
    onOpen: setOpenItem,
    onQuickAdd: quickAdd,
    onStep: step,
  });

  return (
    <main className="pb-[calc(var(--tabbar-h)+1.5rem)]">
      <header className="px-5 pb-1 pt-[calc(env(safe-area-inset-top)+1rem)]">
        {design.header === 'center' ? (
          <div className="flex flex-col items-center text-center">
            <VendorMark vendor={menu.vendor} size="sm" />
            <h1 className="display mt-2.5 break-words text-[32px] font-semibold leading-[1.05] text-ink">{menu.vendor.name}</h1>
            <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-soft">
              {`Table ${menu.table.number}`}
              {payChips.length > 0 && (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="sr-only">Ways to pay: </span>
                  {payChips.map((c) => c.label).join(' · ')}
                </>
              )}
            </p>
            <span aria-hidden="true" className="mt-3 h-px w-14 bg-ink-soft/40" />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <VendorMark vendor={menu.vendor} size="sm" />
            <div className="min-w-0 flex-1">
              <h1 className="display break-words text-[24px] font-extrabold leading-[1.1] text-ink">{menu.vendor.name}</h1>
              {payChips.length > 0 && (
                <p className="mt-0.5 truncate text-xs font-semibold text-ink-soft">
                  <span className="sr-only">Ways to pay: </span>
                  {payChips.map((c) => c.label).join(' · ')}
                </p>
              )}
            </div>
            <p className="inline-flex shrink-0 items-center gap-2 rounded-chip bg-card py-1.5 pl-2.5 pr-3 text-[13px] font-bold text-ink ring-1 ring-inset ring-line">
              <span aria-hidden="true" className="relative flex size-2.5">
                <span className="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />
                <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
              </span>
              {`Table ${menu.table.number}`}
            </p>
          </div>
        )}

        {/* iOS search field: a grey rounded well, no border. */}
        <div className={`relative ${design.header === 'center' ? 'mt-5' : 'mt-3.5'}`}>
          <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 z-10 size-[18px] -translate-y-1/2 text-ink-soft" />
          <input
            id="menu-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search dishes"
            aria-label="Search the menu"
            enterKeyHint="search"
            autoComplete="off"
            className="h-11 w-full appearance-none rounded-xl border-0 bg-fill pl-10 pr-11 text-ink placeholder:text-ink-soft [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full text-ink-soft hover:bg-fill"
            >
              <CloseIcon className="size-4" />
            </button>
          )}
        </div>

        {dietChips.length > 0 && (
          <div role="group" aria-label="Filter by food type" className={`mt-2.5 flex flex-wrap ${design.chips === 'underline' ? 'justify-center gap-4' : 'gap-2'}`}>
            {[['', 'All'], ...dietChips.map((k) => [k, k === 'nonveg' ? 'Non-veg' : k === 'veg' ? 'Veg' : DIET_LABELS[k].replace('Contains egg', 'Egg')])].map(([key, label]) => (
              <button
                key={key || 'all'}
                type="button"
                aria-pressed={diet === key}
                onClick={() => setDiet(key)}
                className={
                  design.chips === 'underline'
                    ? `min-h-9 border-b-2 px-1 text-[13px] font-semibold transition-colors ${diet === key ? 'border-brand-600 text-ink' : 'border-transparent text-ink-soft'}`
                    : `min-h-9 rounded-chip px-3.5 text-[13px] font-bold transition-colors ${diet === key ? 'bg-brand-600 text-white' : 'bg-fill text-ink hover:bg-fill-strong'}`
                }
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </header>

      {activeOrder && (
        <div className="px-4 pt-3">
          <Link
            to={`/o/${activeOrder.token}`}
            className="flex min-h-14 items-center gap-3 rounded-2xl bg-inverse px-4 py-3 text-on-inverse shadow-soft transition-colors hover:bg-inverse/90"
          >
            <span className="relative flex size-2.5 shrink-0">
              <span aria-hidden="true" className="absolute inline-flex size-full rounded-full bg-saffron-300 opacity-70 motion-safe:animate-ping" />
              <span aria-hidden="true" className="relative inline-flex size-2.5 rounded-full bg-saffron-300" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold">
                Your order{activeOrder.order ? ` · ${formatMoney(activeOrder.order.total)}` : ''}
              </span>
              <span className="block text-xs text-on-inverse/70">
                {activeOrder.order ? ORDER_STATUS_TEXT[activeOrder.order.status === 'accepted' && activeOrder.order.ready_at ? 'ready' : activeOrder.order.status] ?? 'In progress' : 'You have an order in progress'}
              </span>
            </span>
            <ChevronRightIcon className="size-5 shrink-0 text-on-inverse/80" />
          </Link>
        </div>
      )}

      {!searching && <RecentOrders orders={recentOrders} tableToken={token} vendorName={menu.vendor.name} />}

      {!searching && chips.length > 1 && (
        <nav aria-label="Menu categories" className="sticky top-0 z-20 mt-3 border-b border-line bg-page/80 backdrop-blur-xl backdrop-saturate-150">
          <div ref={chipScroller} className={`flex overflow-x-auto px-4 py-3 ${design.chips === 'underline' ? 'gap-5 py-1' : 'gap-2'} [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}>
            {chips.map((c) => {
              const active = activeId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => jumpTo(c.id)}
                  className={
                    design.chips === 'underline'
                      ? `min-h-10 shrink-0 border-b-2 px-1.5 text-[15px] font-semibold transition-colors ${active ? 'border-brand-600 text-ink' : 'border-transparent text-ink-soft'}`
                      : `min-h-10 shrink-0 rounded-chip px-4 text-sm font-bold transition-colors ${active ? 'bg-brand-600 text-white' : 'bg-fill text-ink hover:bg-fill-strong'}`
                  }
                >
                  {c.name}
                </button>
              );
            })}
          </div>
        </nav>
      )}

      <div className="space-y-9 px-4 pt-5">
        {searching ? (
          <section aria-label="Search results">
            <p role="status" className="px-1 text-sm font-semibold text-ink-soft">
              {results.length === 0 ? 'No matches' : `${results.length} ${results.length === 1 ? 'dish' : 'dishes'} found`}
            </p>
            {results.length > 0 ? (
              <DishList items={results} cardProps={cardProps} />
            ) : (
              <EmptyState
                as="h2"
                icon={<SearchIcon className="size-8" />}
                title={`Nothing matches “${query.trim()}”`}
                action={
                  <Button variant="secondary" onClick={() => setQuery('')}>
                    Clear search
                  </Button>
                }
              >
                Try a different word, or browse the categories.
              </EmptyState>
            )}
          </section>
        ) : (
          <>
            {picks.length > 0 && (
              <section id="sec-picks" aria-labelledby="h-picks" className="scroll-mt-24">
                <SectionTitle id="h-picks" name="Chef’s picks" description={design.list === 'compact' ? '' : 'What the kitchen is proudest of.'} />
                {design.list === 'compact' ? (
                  <DishList items={picks} cardProps={cardProps} />
                ) : (
                  <ul className="-mx-4 mt-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {picks.map((item) => (
                      <li key={item.id} className="contents">
                        <PickCard {...cardProps(item)} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {sections.map((section) => (
              <section key={section.id} id={`sec-${section.id}`} aria-labelledby={`cat-${section.id}`} className="scroll-mt-24">
                <SectionTitle id={`cat-${section.id}`} name={section.name} count={section.items.length} description={section.description} />
                <DishList items={section.items} cardProps={cardProps} />
              </section>
            ))}
          </>
        )}

        {allItems.length === 0 && (
          <EmptyState as="h2" icon={<MenuBookIcon className="size-8" />} title="The menu is empty right now">
            Nothing is available to order at the moment. Please ask a member of staff.
          </EmptyState>
        )}
        {allItems.length > 0 && items.length === 0 && (
          <EmptyState
            as="h2"
            icon={<MenuBookIcon className="size-8" />}
            title="No dishes of this type"
            action={
              <Button variant="secondary" onClick={() => setDiet('')}>
                Show all dishes
              </Button>
            }
          >
            Try another filter.
          </EmptyState>
        )}
      </div>

      {openItem && <ItemSheet key={openItem.id} item={openItem} onClose={() => setOpenItem(null)} onAdd={addFromSheet} />}
    </main>
  );
}

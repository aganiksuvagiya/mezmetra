import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DishCard, PickCard } from '../components/DishCard';
import EmptyState from '../components/EmptyState';
import { Button } from '../components/Button';
import { ChevronRightIcon, CloseIcon, MenuBookIcon, SearchIcon } from '../components/Icons';
import ItemSheet from '../components/ItemSheet';
import { useToast } from '../components/Toast';
import { buildLine, lineKey, MAX_LINES, MAX_QTY } from '../lib/cart';
import { useActiveOrder } from '../lib/useActiveOrder';
import { useTable } from '../lib/tableContext';
import { usePageTitle } from '../lib/usePageTitle';
import { formatMoney } from '../lib/money';

const ORDER_STATUS_TEXT = {
  pending: 'Received - waiting for the kitchen',
  accepted: 'Being prepared',
  completed: 'Served - payment is still due',
};

// Height of the sticky category bar (plus a little air): where a section "starts" when it counts as the current one.
const NAV_OFFSET = 96;

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

export default function MenuPage() {
  const { token, menu, cart } = useTable();
  const toast = useToast();
  const activeOrder = useActiveOrder(token);
  const [openItem, setOpenItem] = useState(null);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState(null);
  const chipScroller = useRef(null);
  usePageTitle(`Menu - ${menu.vendor.name}`);

  const { categories, items } = menu;

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
      <header className="aurora relative px-5 pb-4 pt-[calc(env(safe-area-inset-top)+1.25rem)]">
        <span className="glass inline-flex items-center gap-2 rounded-full py-1.5 pl-3 pr-3.5 text-[13px] font-bold text-ink">
          <span className="relative flex size-2.5">
            <span aria-hidden="true" className="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />
            <span aria-hidden="true" className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
          </span>
          {`Table ${menu.table.number}`}
        </span>
        <h1 className="display mt-6 break-words text-[34px] font-extrabold leading-[1.02] text-ink">{menu.vendor.name}</h1>
        <p className="mt-1.5 text-[15px] text-ink-soft">What are you craving today?</p>

        <div className="relative mt-5">
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 z-10 size-5 -translate-y-1/2 text-ink-soft" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search dishes"
            aria-label="Search the menu"
            enterKeyHint="search"
            autoComplete="off"
            className="glass h-[52px] w-full appearance-none rounded-full border-0 pl-12 pr-12 text-ink shadow-soft placeholder:text-ink-soft [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full text-ink-soft hover:bg-black/5"
            >
              <CloseIcon className="size-4" />
            </button>
          )}
        </div>
      </header>

      {activeOrder && (
        <div className="px-4 pt-1">
          <Link
            to={`/o/${activeOrder.token}`}
            className="flex min-h-14 items-center gap-3 rounded-2xl bg-ink px-4 py-3 text-white shadow-soft transition-colors hover:bg-ink/90"
          >
            <span className="relative flex size-2.5 shrink-0">
              <span aria-hidden="true" className="absolute inline-flex size-full rounded-full bg-saffron-300 opacity-70 motion-safe:animate-ping" />
              <span aria-hidden="true" className="relative inline-flex size-2.5 rounded-full bg-saffron-300" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold">
                Your order{activeOrder.order ? ` · ${formatMoney(activeOrder.order.total)}` : ''}
              </span>
              <span className="block text-xs text-white/70">
                {activeOrder.order ? ORDER_STATUS_TEXT[activeOrder.order.status] ?? 'In progress' : 'You have an order in progress'}
              </span>
            </span>
            <ChevronRightIcon className="size-5 shrink-0 text-white/80" />
          </Link>
        </div>
      )}

      {!searching && chips.length > 1 && (
        <nav aria-label="Menu categories" className="sticky top-0 z-20 mt-3 border-b border-black/5 bg-page/80 backdrop-blur-xl">
          <div ref={chipScroller} className="flex gap-2 overflow-x-auto px-4 py-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {chips.map((c) => {
              const active = activeId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => jumpTo(c.id)}
                  className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-bold transition-colors ${
                    active ? 'bg-ink text-white shadow-soft' : 'bg-white text-ink ring-1 ring-inset ring-black/5 hover:bg-black/5'
                  }`}
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
              <ul className="surface mt-3 divide-y divide-black/5 overflow-hidden">
                {results.map((item) => (
                  <li key={item.id}>
                    <DishCard {...cardProps(item)} />
                  </li>
                ))}
              </ul>
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
                <h2 id="h-picks" className="display px-1 text-2xl font-extrabold text-ink">
                  Chef&apos;s picks
                </h2>
                <p className="mt-0.5 px-1 text-sm text-ink-soft">What the kitchen is proudest of.</p>
                <ul className="-mx-4 mt-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {picks.map((item) => (
                    <li key={item.id} className="contents">
                      <PickCard {...cardProps(item)} />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {sections.map((section) => (
              <section key={section.id} id={`sec-${section.id}`} aria-labelledby={`cat-${section.id}`} className="scroll-mt-24">
                <h2 id={`cat-${section.id}`} className="display flex items-baseline gap-2 px-1 text-2xl font-extrabold text-ink">
                  {section.name}
                  <span className="text-sm font-semibold tracking-normal text-ink-soft">{section.items.length}</span>
                </h2>
                {section.description && <p className="mt-0.5 px-1 text-sm text-ink-soft">{section.description}</p>}
                <ul className="surface mt-4 divide-y divide-black/5 overflow-hidden">
                  {section.items.map((item) => (
                    <li key={item.id}>
                      <DishCard {...cardProps(item)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}

        {items.length === 0 && (
          <EmptyState as="h2" icon={<MenuBookIcon className="size-8" />} title="The menu is empty right now">
            Nothing is available to order at the moment. Please ask a member of staff.
          </EmptyState>
        )}
      </div>

      {openItem && <ItemSheet key={openItem.id} item={openItem} onClose={() => setOpenItem(null)} onAdd={addFromSheet} />}
    </main>
  );
}

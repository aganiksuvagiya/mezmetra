import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Alert from '../components/Alert';
import { Button, LinkButton } from '../components/Button';
import DishImage from '../components/DishImage';
import EmptyState from '../components/EmptyState';
import { ArrowLeftIcon, CardIcon, CartIcon, CashIcon, PhoneIcon, PlusIcon, SpinnerIcon, TrashIcon } from '../components/Icons';
import QuantityStepper from '../components/QuantityStepper';
import BillSummary from '../components/BillSummary';
import { useToast } from '../components/Toast';
import { ApiError, createOrder, errorMessage } from '../lib/api';
import { buildOrderBody, describeDropped, lineTotalPaise, MAX_NOTE } from '../lib/cart';
import { clearIdempotencyKey, idempotencyKeyFor } from '../lib/idempotency';
import { formatMoney, formatPaise } from '../lib/money';
import { rememberOrder } from '../lib/orderMemory';
import { getJSON, removeItem, setJSON } from '../lib/storage';
import { useTable } from '../lib/tableContext';
import { usePageTitle } from '../lib/usePageTitle';

const checkoutKey = (token) => `mezmitra_checkout_${token}`;

// Server codes that mean "the menu changed under your cart" - refresh and let the diner review.
const MENU_CHANGED = new Set(['ITEM_UNAVAILABLE', 'INVALID_OPTION', 'OPTION_REQUIRED', 'OPTION_TOO_MANY', 'PAYMENT_METHOD_UNAVAILABLE']);

export default function CartPage() {
  const { token, menu, cart, refreshMenu } = useTable();
  const navigate = useNavigate();
  const toast = useToast();
  usePageTitle(`Your cart - ${menu.vendor.name}`);

  const canOnline = menu.payment_options?.razorpay === true;
  const canUpi = menu.payment_options?.upi === true;
  const canCounter = menu.payment_options?.cash === true;
  const available = [canCounter && 'counter', canUpi && 'upi', canOnline && 'online'].filter(Boolean);
  // A restaurant that has not set up a way to pay (for example no UPI ID yet) cannot take orders; the server refuses them too.
  const cannotPay = available.length === 0;

  const dishById = useMemo(() => new Map(menu.items.map((i) => [i.id, i])), [menu.items]);
  const saved = useMemo(() => getJSON(checkoutKey(token), {}) ?? {}, [token]);
  const [note, setNote] = useState(typeof saved.note === 'string' ? saved.note.slice(0, MAX_NOTE) : '');
  const [payPref, setPayPref] = useState(['online', 'upi'].includes(saved.payPref) ? saved.payPref : 'counter');
  const pref = available.includes(payPref) ? payPref : available[0];

  const [pending, setPending] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [problem, setProblem] = useState(null);
  const submitting = useRef(false);
  const problemRef = useRef(null);

  // Remember the note and payment choice while the diner browses back and forth.
  useEffect(() => {
    if (!note && payPref === 'counter') removeItem(checkoutKey(token));
    else setJSON(checkoutKey(token), { note, payPref });
  }, [token, note, payPref]);

  useEffect(() => {
    problemRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [problem]);

  const taxPercent = Number(menu.vendor.tax_percent) || 0;
  const subtotalPaise = cart.subtotalPaise;
  const taxPaise = Math.round((subtotalPaise * taxPercent) / 100); // same rounding as the server
  const totalPaise = subtotalPaise + taxPaise;

  const removeLine = (line) => {
    const undo = cart.remove(line.key);
    if (undo) toast.show(`${line.name} removed from your cart`, { action: { label: 'Undo', onClick: () => cart.restore(undo) } });
  };

  const placeOrder = async () => {
    if (submitting.current) return; // synchronous guard: state updates are too slow to stop a rapid double tap
    const lines = cart.getLines();
    if (lines.length === 0 || cannotPay) return;
    submitting.current = true;
    setPending(true);
    setProblem(null);

    const body = buildOrderBody(lines, note, pref);
    // Same cart -> same key (retries return the same order); changed cart -> new key.
    const key = idempotencyKeyFor(token, JSON.stringify(body.items));

    try {
      const order = await createOrder(token, body, key);
      setPlaced(true);
      rememberOrder(token, order.token);
      clearIdempotencyKey(token);
      removeItem(checkoutKey(token));
      cart.clear();
      navigate(`/o/${order.token}`, { replace: true, state: { tableToken: token } });
    } catch (err) {
      submitting.current = false;
      setPending(false);
      const code = err instanceof ApiError ? err.code : '';

      if (MENU_CHANGED.has(code) || code === 'TABLE_UNAVAILABLE') {
        const fresh = await refreshMenu();
        // For a dish that was deleted outright the server can only name it as "#<id>"; our own list has real names.
        const message = /#\d+/.test(err.message) && fresh?.dropped.length ? describeDropped(fresh.dropped) : err.message;
        setProblem({
          title:
            code === 'TABLE_UNAVAILABLE'
              ? "This table isn't taking orders"
              : code === 'PAYMENT_METHOD_UNAVAILABLE'
                ? 'Please choose how to pay again'
                : 'Your cart needs a quick review',
          message,
          removed: message === err.message ? (fresh?.dropped ?? []) : [],
          hint:
            code === 'TABLE_UNAVAILABLE'
              ? 'Your cart is saved. Please ask a member of staff for help.'
              : fresh
                ? "We've updated your cart. Please check it and place your order again."
                : "We couldn't refresh the menu. Remove the dishes mentioned above, or reload the page, then try again.",
        });
        return;
      }

      const unreachable = err instanceof ApiError && err.status === 0;
      setProblem({
        title: unreachable ? "Your order hasn't been confirmed" : "We couldn't place your order",
        message: errorMessage(err, 'Something went wrong while placing your order. Please try again.'),
        removed: [],
        hint: unreachable ? 'It is safe to tap Place order again - the same order will not be created twice.' : '',
      });
    }
  };

  if (placed) {
    return (
      <main className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-6 text-center">
        <SpinnerIcon className="size-8 text-brand-600" />
        <p role="status" className="font-bold text-ink">
          Order placed - opening your order…
        </p>
      </main>
    );
  }

  const empty = cart.lines.length === 0;

  return (
    <main className="pb-[calc(env(safe-area-inset-bottom)+8rem)]">
      <header className="px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <div className="flex items-center justify-between gap-3">
          <Link to={`/t/${token}`} className="-ml-1 inline-flex min-h-11 items-center gap-0.5 rounded-xl pr-2 text-[17px] font-medium text-brand-700 active:opacity-60">
            <ArrowLeftIcon className="size-5" />
            Menu
          </Link>
          <span className="rounded-full bg-white px-3 py-1.5 text-[13px] font-bold text-ink ring-1 ring-inset ring-black/5">Table {menu.table.number}</span>
        </div>
        <h1 className="display mt-2 text-[34px] font-extrabold leading-tight text-ink">Your cart</h1>
        <p className="truncate text-[15px] text-ink-soft">{menu.vendor.name}</p>
      </header>

      <div className="space-y-4 px-4 pt-2">
        {problem && (
          <div ref={problemRef}>
            <Alert tone="error" title={problem.title}>
              <p>{problem.message}</p>
              {problem.removed.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {problem.removed.map((name) => (
                    <li key={name}>{name} - removed</li>
                  ))}
                </ul>
              )}
              {problem.hint && <p className="mt-1">{problem.hint}</p>}
            </Alert>
          </div>
        )}

        {empty ? (
          <EmptyState
            as="h2"
            icon={<CartIcon className="size-8" />}
            title="Your cart is empty"
            action={
              <LinkButton to={`/t/${token}`} block>
                Browse menu
              </LinkButton>
            }
          >
            Add a few dishes from the menu and they will show up here.
          </EmptyState>
        ) : (
          <>
            <ul className="surface divide-y divide-black/5 overflow-hidden" aria-label="Items in your cart">
              {cart.lines.map((line) => (
                <li key={line.key} className="flex gap-3.5 p-4">
                  <DishImage item={dishById.get(line.itemId) ?? { id: line.itemId, name: line.name }} className="size-[4.5rem] shrink-0 rounded-[18px]" iconClass="size-9" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-bold leading-snug tracking-tight text-ink">{line.name}</p>
                        {line.options.length > 0 && <p className="text-sm text-ink-soft">{line.options.map((o) => o.name).join(', ')}</p>}
                        {line.instructions && <p className="mt-0.5 break-words text-sm italic text-ink-soft">“{line.instructions}”</p>}
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-extrabold tabular-nums text-ink">{formatPaise(lineTotalPaise(line))}</p>
                        {line.quantity > 1 && <p className="text-xs text-ink-soft">{formatMoney(line.unitPrice)} each</p>}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <QuantityStepper value={line.quantity} onChange={(q) => cart.setQuantity(line.key, q)} label={line.name} />
                      <button
                        type="button"
                        onClick={() => removeLine(line)}
                        aria-label={`Remove ${line.name} from cart`}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-2.5 text-sm font-bold text-rose-700 hover:bg-rose-50"
                      >
                        <TrashIcon className="size-4" />
                        <span className="hidden min-[360px]:inline">Remove</span>
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <Link
              to={`/t/${token}`}
              className="flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-dashed border-brand-300 bg-white/60 text-base font-bold text-brand-700 hover:bg-brand-50"
            >
              <PlusIcon className="size-5" />
              Add more
            </Link>

            <section className="surface p-4">
              <label htmlFor="kitchen-note" className="flex items-baseline justify-between gap-2 font-extrabold text-ink">
                <span>Note for the kitchen</span>
                <span className="text-xs font-semibold text-ink-soft">Optional</span>
              </label>
              <textarea
                id="kitchen-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={MAX_NOTE}
                rows={2}
                placeholder="e.g. allergic to nuts, bring water first"
                className="mt-2 block w-full resize-none rounded-2xl border-0 bg-page px-3 py-2.5 text-ink ring-1 ring-inset ring-line placeholder:text-ink-soft/70"
              />
              <p className="mt-1 text-right text-xs text-ink-soft" aria-hidden="true">
                {`${note.length}/${MAX_NOTE}`}
              </p>
            </section>

            <section className="surface p-4">
              <h2 className="mb-3 font-bold tracking-tight text-ink">Bill summary</h2>
              <BillSummary
                subtotal={subtotalPaise / 100}
                tax={taxPaise / 100}
                total={totalPaise / 100}
                taxLabel={`Tax (${taxPercent}%)`}
                totalLabel="Estimated total"
                footnote="Estimated total; the final amount is confirmed when you place the order."
              />
            </section>

            <fieldset className="surface p-4">
              <legend className="sr-only">How would you like to pay?</legend>
              <p aria-hidden="true" className="mb-3 font-bold tracking-tight text-ink">
                How would you like to pay?
              </p>
              {cannotPay && (
                <Alert tone="error" title="This restaurant can't take orders yet">
                  <p>It hasn&apos;t finished setting up payments. Please ask a member of staff.</p>
                </Alert>
              )}
              <div className="space-y-2">
                {canCounter && (
                  <PayOption
                    checked={pref === 'counter'}
                    onSelect={() => setPayPref('counter')}
                    icon={<CashIcon className="size-5" />}
                    title="Pay at the counter"
                    text="Settle up with the staff when you are done."
                  />
                )}
                {canUpi && (
                  <PayOption
                    checked={pref === 'upi'}
                    onSelect={() => setPayPref('upi')}
                    icon={<PhoneIcon className="size-5" />}
                    title="Pay with a UPI app"
                    text="Google Pay, PhonePe, Paytm or any UPI app - you'll see how to pay once you place the order."
                  />
                )}
                {canOnline && (
                  <PayOption
                    checked={pref === 'online'}
                    onSelect={() => setPayPref('online')}
                    icon={<CardIcon className="size-5" />}
                    title="Pay online"
                    text="UPI, cards or netbanking - you will pay securely after the order is placed."
                  />
                )}
              </div>
            </fieldset>
          </>
        )}
      </div>

      {!empty && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30">
          <div className="glass pointer-events-auto mx-auto flex max-w-md items-center gap-4 rounded-t-[1.25rem] px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 motion-safe:animate-bar-in">
            <div className="shrink-0">
              <p className="text-xs font-semibold text-ink-soft">Estimated total</p>
              <p className="text-xl font-extrabold leading-tight tabular-nums text-ink">{formatPaise(totalPaise)}</p>
            </div>
            <Button className="min-h-12 min-w-0 flex-1" onClick={placeOrder} loading={pending} disabled={cannotPay}>
              {pending ? 'Placing order…' : 'Place order'}
            </Button>
          </div>
          <p role="status" className="sr-only">
            {pending ? 'Placing your order' : ''}
          </p>
        </div>
      )}
    </main>
  );
}

function PayOption({ checked, onSelect, icon, title, text }) {
  return (
    <label
      className={`flex min-h-16 cursor-pointer items-center gap-3 rounded-[20px] p-3.5 ring-1 ring-inset has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-800 ${
        checked ? 'bg-brand-50 ring-2 ring-brand-600' : 'bg-white ring-line hover:bg-page'
      }`}
    >
      <input type="radio" name="pay-pref" checked={checked} onChange={onSelect} className="size-5 shrink-0 accent-brand-600 focus-visible:outline-none" />
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700">{icon}</span>
      <span className="min-w-0">
        <span className="block font-bold text-ink">{title}</span>
        <span className="block text-sm text-ink-soft">{text}</span>
      </span>
    </label>
  );
}

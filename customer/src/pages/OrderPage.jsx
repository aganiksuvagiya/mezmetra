import { useEffect, useRef } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import Alert from '../components/Alert';
import BillSummary from '../components/BillSummary';
import { Button, LinkButton } from '../components/Button';
import EmptyState from '../components/EmptyState';
import { AlertIcon, CheckIcon, ClockIcon, CloseIcon, MenuBookIcon, QrIcon } from '../components/Icons';
import OrderItems from '../components/OrderItems';
import PaymentCard from '../components/PaymentCard';
import ServiceButtons from '../components/ServiceButtons';
import { OrderSkeleton } from '../components/Skeleton';
import StatusStepper from '../components/StatusStepper';
import VendorMark from '../components/VendorMark';
import { errorMessage } from '../lib/api';
import { alertOrderReady } from '../lib/readyAlert';
import { TABLE_TOKEN_RE } from '../lib/ids';
import { forgetLastOrder, isFinished, tableForOrder } from '../lib/orderMemory';
import { applyTheme } from '../lib/theme';
import { formatTime } from '../lib/time';
import { useOrder } from '../lib/useOrder';
import { usePageTitle } from '../lib/usePageTitle';

const HEADLINE = {
  pending: ['Order received', 'Your order is with the kitchen. We will let you know here as soon as it is accepted.'],
  accepted: ['Your order is being prepared', 'The kitchen has accepted your order and is working on it.'],
  ready: ['Your order is ready!', 'The kitchen has finished it. It is on its way to your table.'],
  completed: ['Order completed', 'Enjoy your meal!'],
};

export default function OrderPage() {
  const { orderToken } = useParams();
  // Re-mount per order so polling state never leaks between orders.
  return <OrderView key={orderToken} orderToken={orderToken} />;
}

function OrderView({ orderToken }) {
  const location = useLocation();
  const { state, reload, refresh, applyOrder } = useOrder(orderToken);
  const order = state.order;

  // Which table to send "Order more" to: navigation state (set when the order was placed) or this device's memory.
  const fromState = location.state?.tableToken;
  const tableToken = (TABLE_TOKEN_RE.test(fromState ?? '') && fromState) || tableForOrder(orderToken);

  usePageTitle(order ? `Your order - ${order.vendor.name}` : 'Your order - MezMitra');

  useEffect(() => {
    if (order?.vendor?.theme) applyTheme(order.vendor.theme);
  }, [order?.vendor?.theme?.primary, order?.vendor?.theme?.accent]); // eslint-disable-line react-hooks/exhaustive-deps

  // The kitchen marks the order ready while this page is open: a short vibration and chime (not on the first load).
  const readyAt = order?.ready_at ?? null;
  const seenReady = useRef(undefined);
  useEffect(() => {
    if (!order) return;
    if (seenReady.current === undefined) {
      seenReady.current = readyAt; // what was already true when the page opened does not alert
      return;
    }
    if (readyAt && !seenReady.current) alertOrderReady();
    seenReady.current = readyAt;
  }, [order, readyAt]);

  // Once the order is over (cancelled, or completed and paid) stop nagging about it on the menu.
  useEffect(() => {
    if (order && tableToken && isFinished(order)) forgetLastOrder(tableToken, orderToken);
  }, [order, tableToken, orderToken]);

  if (state.status === 'loading') return <OrderSkeleton />;

  if (state.status === 'notfound') {
    return (
      <main className="flex min-h-dvh flex-col justify-center">
        <EmptyState
          icon={<QrIcon className="size-8" />}
          tone="danger"
          title="We can't find this order"
          action={
            <LinkButton to={tableToken ? `/t/${tableToken}` : '/'} block>
              {tableToken ? 'Back to the menu' : 'Go to the start'}
            </LinkButton>
          }
        >
          The link may be incomplete or the order may have been removed. If you have just ordered, please ask a member of staff.
        </EmptyState>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className="flex min-h-dvh flex-col justify-center">
        <EmptyState
          icon={<AlertIcon className="size-8" />}
          tone="danger"
          title="Your order didn't load"
          action={
            <Button onClick={reload} block>
              Retry
            </Button>
          }
        >
          {errorMessage(state.error)}
        </EmptyState>
      </main>
    );
  }

  const cancelled = order.status === 'cancelled';
  const isReady = order.status === 'accepted' && Boolean(order.ready_at);
  const [headline, sub] = HEADLINE[isReady ? 'ready' : order.status] ?? ['Order update', ''];

  return (
    <main className="pb-[calc(2rem+env(safe-area-inset-bottom))]">
      <header className="aurora px-5 pb-4 pt-[calc(env(safe-area-inset-top)+1.25rem)]">
        <p className="flex flex-wrap items-center gap-2 text-[13px] font-bold">
          <span className="glass rounded-full px-3.5 py-1.5 text-ink">{`Table ${order.table_number}`}</span>
          {order.created_at && (
            <span className="inline-flex items-center gap-1.5 text-ink-soft">
              <ClockIcon className="size-4" />
              {`Placed ${formatTime(order.created_at)}`}
            </span>
          )}
        </p>
        <div className="mt-5 flex items-center gap-3.5">
          <VendorMark vendor={order.vendor} />
          <div className="min-w-0">
            <p className="text-[13px] font-bold uppercase tracking-[0.16em] text-ink-soft">Your order at</p>
            <h1 className="display mt-0.5 break-words text-[30px] font-extrabold leading-[1.05] text-ink">{order.vendor.name}</h1>
          </div>
        </div>
      </header>

      <div className="space-y-4 px-4 pt-1">
        {state.stale && <Alert tone="warning">We&apos;re having trouble refreshing. This page keeps trying automatically.</Alert>}

        {cancelled ? (
          <section aria-label="Order status" className="surface p-4">
            <div className="flex items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-rose-100 text-rose-700">
                <CloseIcon className="size-6" />
              </span>
              <div aria-live="polite">
                <h2 className="text-lg font-extrabold text-rose-800">Order cancelled</h2>
                <p className="text-sm text-ink-soft">
                  This order was cancelled and you have not been charged. If you think this is a mistake, please speak to a member of staff.
                </p>
              </div>
            </div>
          </section>
        ) : (
          <section aria-label="Order status" className="relative overflow-hidden rounded-[1.75rem] bg-gradient-to-br from-brand-700 via-brand-800 to-brand-900 p-5 text-white shadow-soft">
            <span aria-hidden="true" className="pointer-events-none absolute -right-12 -top-14 size-48 rounded-full bg-saffron-300/30 blur-3xl" />
            <div className="relative flex items-start gap-3.5">
              <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/15 ring-1 ring-inset ring-white/25">
                {order.status === 'completed' || isReady ? <CheckIcon className="size-6" /> : order.status === 'accepted' ? <MenuBookIcon className="size-6" /> : <ClockIcon className="size-6 motion-safe:animate-pulse" />}
              </span>
              <div aria-live="polite" className="min-w-0">
                <h2 className="display text-[22px] font-extrabold leading-tight">{headline}</h2>
                {sub && <p className="mt-1 text-sm text-white/80">{sub}</p>}
              </div>
            </div>
            <div className="relative">
              <StatusStepper status={order.status} ready={isReady} tone="light" />
              <p className="mt-4 text-xs text-white/70">This page updates automatically - no need to refresh.</p>
            </div>
          </section>
        )}

        <section aria-labelledby="order-items" className="surface p-4">
          <h2 id="order-items" className="mb-3 font-extrabold text-ink">
            Your order <span className="font-semibold text-ink-soft">({order.total_quantity} {order.total_quantity === 1 ? 'item' : 'items'})</span>
          </h2>
          <OrderItems items={order.items} />
          <div className="mt-4 border-t border-line pt-4">
            <BillSummary subtotal={order.subtotal} tax={order.tax} total={order.total} />
          </div>
          {order.note && (
            <div className="mt-4 rounded-2xl bg-page px-3 py-2.5 text-sm">
              <p className="font-bold text-ink">Note for the kitchen</p>
              <p className="mt-0.5 whitespace-pre-line break-words text-ink-soft">{order.note}</p>
            </div>
          )}
        </section>

        <PaymentCard order={order} onPaid={applyOrder} onRefresh={refresh} />

        {tableToken && !cancelled && <ServiceButtons tableToken={tableToken} className="justify-center" />}

        <div className="pt-2 text-center">
          {tableToken ? (
            <Link
              to={`/t/${tableToken}`}
              className="surface inline-flex min-h-12 items-center justify-center !rounded-full px-7 text-base font-bold text-brand-700 hover:bg-brand-50"
            >
              Order more
            </Link>
          ) : (
            <p className="text-sm text-ink-soft">To order more, scan the QR code on your table again.</p>
          )}
        </div>
      </div>
    </main>
  );
}

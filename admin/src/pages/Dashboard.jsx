import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Alert, EmptyState, ErrorState } from '../components/EmptyState.jsx';
import { Button } from '../components/Button.jsx';
import { PaymentBadge } from '../components/Badge.jsx';
import { Card, CardHeader, PageHeader } from '../components/Card.jsx';
import { BagIcon, ChevronRightIcon, ImageIcon, InfoIcon, OrdersIcon, QrIcon, RefreshIcon, RupeeIcon, TrendingIcon } from '../components/icons.jsx';
import { DishThumb, OrderThumb, StagePill } from '../components/OrderParts.jsx';
import RevenueChart from '../components/RevenueChart.jsx';
import { Skeleton } from '../components/Spinner.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useLiveOrders } from '../context/LiveOrdersContext.jsx';
import { api } from '../lib/api.js';
import { formatNumber, orderItemsSummary } from '../lib/format.js';
import { useDocumentTitle, useQuery } from '../lib/hooks.js';
import { canTakeOrders, METHOD_LABEL } from '../lib/payments.js';
import { useFmt } from '../lib/useFmt.js';

const REFRESH_MS = 8000;
const METHOD_BAR = { cash: 'bg-brand-500', upi: 'bg-violet-500' }; // online gateways share the blue bar

function StatCard({ icon: Icon, label, value, note, to, linkLabel }) {
  return (
    <div className="flex flex-col rounded-2xl border border-black/[0.05] bg-white p-3.5 @xl:p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-100/70 text-brand-700">
          <Icon size={18} />
        </span>
        {to && (
          <Link to={to} className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-brand-700 hover:underline @xl:text-sm">
            {linkLabel}
            <ChevronRightIcon size={14} />
          </Link>
        )}
      </div>
      <p className="mt-3 text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tracking-tight text-slate-900 tabular-nums @xl:text-3xl">{value}</p>
      <p className="mt-1 text-xs text-slate-500 @xl:text-sm">{note}</p>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-3 @xl:space-y-4" role="status" aria-label="Loading dashboard">
      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-32 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-3 @xl:gap-4 @4xl:grid-cols-3">
        <Skeleton className="h-72 rounded-2xl @4xl:col-span-2" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
      <div className="grid gap-3 @xl:gap-4 @4xl:grid-cols-3">
        <Skeleton className="h-64 rounded-2xl @4xl:col-span-2" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </div>
  );
}

function PaymentSplit({ methods, days, fmt }) {
  const total = methods.reduce((n, m) => n + (Number(m.amount) || 0), 0);
  return (
    <Card as="section" aria-labelledby="payment-split" className="min-w-0">
      <CardHeader id="payment-split" title="Payment split" description={`Paid orders, last ${days} days`} />
      <div className="p-4 sm:p-5">
        {total === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">No paid orders in the last {days} days.</p>
        ) : (
          <ul className="space-y-5">
            {methods.map((m) => (
              <li key={m.method}>
                <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium text-slate-700">{METHOD_LABEL[m.method] ?? m.method}</span>
                  <span className="text-slate-500">
                    <span className="font-semibold text-slate-900 tabular-nums">{fmt.money(m.amount)}</span> · {m.percent}%
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label={METHOD_LABEL[m.method] ?? m.method}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={m.percent}
                  aria-valuetext={`${m.percent}% of paid revenue`}
                  className="h-2.5 overflow-hidden rounded-full bg-slate-100"
                >
                  <div className={`h-full rounded-full ${METHOD_BAR[m.method] ?? 'bg-sky-500'}`} style={{ width: `${m.percent}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export default function Dashboard() {
  useDocumentTitle('Dashboard');
  const { vendor } = useAuth();
  const fmt = useFmt();
  const live = useLiveOrders();
  // Refreshes by itself every few seconds (the same pace as the orders watcher), only while the page is in view.
  const q = useQuery(() => api('/api/admin/dashboard/overview'), [], { interval: REFRESH_MS });
  const pay = useQuery(() => api('/api/admin/payment-settings'), []);

  // The app-wide watcher saw a new order: refresh now instead of waiting for the next timer tick.
  const arrivalsSeen = useRef(live.arrivals);
  useEffect(() => {
    if (live.arrivals === arrivalsSeen.current) return;
    arrivalsSeen.current = live.arrivals;
    q.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.arrivals]);

  const refresh = () => {
    q.reload();
    live.reload();
  };

  const d = q.data;
  const ranges = d?.ranges ?? {};
  const nothingYet = d && d.latest_orders.length === 0 && d.top_selling.length === 0 && Number(d.today_revenue) === 0;

  const liveNote = d
    ? [
        [d.live_pending, 'pending'],
        [d.live_preparing, 'preparing'],
        [d.live_ready, 'ready'],
      ]
        .filter(([n]) => n > 0)
        .map(([n, label]) => `${n} ${label}`)
        .join(' · ') || 'Nothing waiting'
    : '';

  return (
    <div className="@container">
      <PageHeader
        title="Dashboard"
        description={vendor ? `How ${vendor.name} is doing today.` : undefined}
        actions={
          <>
            {q.updatedAt && (
              <span className="text-xs text-slate-500" aria-live="off">
                Updated {fmt.clock(q.updatedAt)}
              </span>
            )}
            <Button variant="secondary" size="sm" icon={RefreshIcon} busy={q.refreshing} onClick={refresh}>
              Refresh
            </Button>
          </>
        }
      />

      {pay.data && !canTakeOrders(pay.data) && (
        <div className="mb-3 @xl:mb-4">
          <Alert tone="warning">
            <strong>Diners can&rsquo;t place orders yet.</strong>{' '}
            Turn on a payment method so they can pay.{' '}
            <Link to="/payments" className="font-semibold text-brand-700 underline underline-offset-2">
              Set up payments
            </Link>
          </Alert>
        </div>
      )}

      {q.loading && <DashboardSkeleton />}
      {!q.loading && !d && <Card><ErrorState error={q.error} onRetry={q.reload} title="Couldn't load the dashboard" /></Card>}

      {d && (
        <div className="space-y-3 @xl:space-y-4">
          {q.error && (
            <Alert tone="warning">
              Couldn&rsquo;t refresh just now ({q.error.message}). Showing the figures from {fmt.clock(q.updatedAt)}.
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
            <StatCard icon={RupeeIcon} label="Today’s revenue" value={fmt.money(d.today_revenue)} note="Paid orders only" />
            <StatCard icon={OrdersIcon} label="Orders today" value={formatNumber(d.today_orders)} note="Not counting cancelled" />
            <StatCard icon={BagIcon} label="Live orders" value={formatNumber(d.live_orders)} note={liveNote} to="/orders" linkLabel="View" />
            <StatCard icon={TrendingIcon} label="Average order" value={fmt.money(d.average_order)} note={`Paid, last ${ranges.payment_days ?? 30} days`} />
          </div>

          {nothingYet && (
            <Card className="border-brand-200 bg-brand-50/60">
              <EmptyState
                icon={QrIcon}
                title="Waiting for your first order"
                message="Print the QR codes for your tables so diners can start ordering. New orders and revenue will show up here."
                action={
                  <Link to="/tables/qr" className="inline-flex h-10 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">
                    Get QR codes
                  </Link>
                }
                className="py-10"
              />
            </Card>
          )}

          <div className="grid gap-3 @xl:gap-4 @4xl:grid-cols-3">
            <Card as="section" aria-labelledby="weekly-revenue" className="min-w-0 @4xl:col-span-2">
              <CardHeader id="weekly-revenue" title="Revenue, last 7 days" description="Hover or focus a bar for the exact amount" />
              <div className="p-4 sm:p-5">
                <RevenueChart days={d.weekly_revenue} />
                <p className="mt-4 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <InfoIcon size={14} className="mt-0.5 text-slate-400" />
                  Revenue counts paid orders only. Unpaid and cancelled orders are not included.
                </p>
              </div>
            </Card>

            <PaymentSplit methods={d.payment_methods.filter((m) => m.amount > 0 || (vendor?.payment_methods ?? [m.method]).includes(m.method))} days={ranges.payment_days ?? 30} fmt={fmt} />
          </div>

          <div className="grid gap-3 @xl:gap-4 @4xl:grid-cols-3">
            <Card as="section" aria-labelledby="latest-orders" className="min-w-0 @4xl:col-span-2">
              <CardHeader
                id="latest-orders"
                title="Latest orders"
                actions={
                  <Link to="/orders" className="inline-flex items-center gap-0.5 text-sm font-medium text-brand-700 hover:underline">
                    View all
                    <ChevronRightIcon size={14} />
                  </Link>
                }
              />
              {d.latest_orders.length === 0 ? (
                <EmptyState icon={OrdersIcon} title="No orders yet" message="Orders placed from your tables will appear here." className="py-10" />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {d.latest_orders.map((o) => (
                    <li key={o.id}>
                      <Link
                        to={`/orders?order=${o.id}`}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 sm:px-5"
                        aria-label={`Order ${o.number}, table ${o.table_number}, ${o.status}, ${o.payment_status}, ${fmt.money(o.total)}`}
                      >
                        <OrderThumb order={o} className="size-14" iconSize={22} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-slate-900">
                            #{o.number} <span className="font-normal text-slate-500">· Table {o.table_number}</span>
                          </p>
                          <p className="line-clamp-1 text-sm text-slate-500">{orderItemsSummary(o.items)}</p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                            <StagePill order={o} />
                            {fmt.dateTime(o.created_at)}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <p className="font-semibold text-slate-900 tabular-nums">{fmt.money(o.total)}</p>
                          <PaymentBadge status={o.payment_status} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card as="section" aria-labelledby="top-selling" className="min-w-0">
              <CardHeader id="top-selling" title="Top-selling dishes" description={`Last ${ranges.top_days ?? 30} days`} />
              {d.top_selling.length === 0 ? (
                <EmptyState icon={TrendingIcon} title="No sales yet" message="Your best sellers will show up once orders are paid." className="py-10" />
              ) : (
                <ol className="divide-y divide-slate-100">
                  {d.top_selling.map((item, i) => (
                    <li key={`${i}-${item.name}`} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                      <span className="relative shrink-0">
                        <DishThumb url={item.photo_url} icon={ImageIcon} iconSize={20} className="size-12" />
                        <span className="absolute -left-1 -top-1 flex size-5 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">{i + 1}</span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900" title={item.name}>
                          {item.name}
                        </p>
                        <p className="text-xs text-slate-500">{formatNumber(item.quantity)} sold</p>
                      </div>
                      <p className="text-sm font-semibold text-slate-900 tabular-nums">{fmt.money(item.revenue)}</p>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

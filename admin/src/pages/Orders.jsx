import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../components/Button.jsx';
import { Card, PageHeader } from '../components/Card.jsx';
import { Alert, EmptyState, ErrorState } from '../components/EmptyState.jsx';
import { ChevronRightIcon, OrdersIcon, RefreshIcon } from '../components/icons.jsx';
import { OrderThumb, StagePill } from '../components/OrderParts.jsx';
import ListSkeleton from '../components/ListSkeleton.jsx';
import Pagination from '../components/Pagination.jsx';
import SearchBox from '../components/SearchBox.jsx';
import StatTile from '../components/StatTile.jsx';
import { panelId, tabId, Tabs } from '../components/Tabs.jsx';
import { useToast } from '../components/Toast.jsx';
import { useLiveOrders } from '../context/LiveOrdersContext.jsx';
import { useReserveSidePanelSpace, useSidePanelSpace } from '../context/SidePanelContext.jsx';
import { api, apiPage } from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { orderItemsSummary } from '../lib/format.js';
import { useClampPage, useDebouncedValue, useDocumentTitle, useMediaQuery, useQuery } from '../lib/hooks.js';
import { useFmt } from '../lib/useFmt.js';
import OrderDetailModal from './orders/OrderDetailModal.jsx';

const PER_PAGE = 12;
const REFRESH_MS = 8000;
// "Open" is every order that is not finished (pending, preparing and ready together). The others are one state each.
const TAB_VALUES = ['active', 'pending', 'preparing', 'ready', 'completed', 'cancelled', 'all'];
const TAB_LABELS = { active: 'Open', pending: 'Pending', preparing: 'Preparing', ready: 'Ready', completed: 'Completed', cancelled: 'Cancelled', all: 'All' };
const COUNT_KEY = { active: 'active', pending: 'pending', preparing: 'preparing', ready: 'ready', completed: 'completed', cancelled: 'cancelled', all: 'all' };

const EMPTY = {
  active: ['No open orders', 'New orders from your tables will appear here automatically.'],
  pending: ['Nothing waiting to be accepted', 'New orders that need accepting will be listed here.'],
  preparing: ['Nothing being prepared', 'Orders you have accepted and not yet marked ready will be listed here.'],
  ready: ['Nothing ready to serve', 'Orders the kitchen has finished will be listed here until they are completed.'],
  completed: ['No completed orders yet', 'Orders you complete will be listed here.'],
  cancelled: ['No cancelled orders', 'Cancelled orders will be listed here.'],
  all: ['No orders yet', 'Once diners start ordering, every order will be listed here.'],
};

// The figures above the list (the first one is every order; the rest are one state each).
const FIGURES = [
  ['all', 'Total orders'],
  ['pending', 'Pending'],
  ['preparing', 'Preparing'],
  ['ready', 'Ready'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
];

function OrderCard({ order, fresh, fmt, onOpen, selected }) {
    return (
    <li className={cx('rounded-2xl', fresh && 'animate-flash')}>
      <button
        type="button"
        onClick={() => onOpen(order.id)}
        aria-current={selected ? 'true' : undefined}
        className={cx(
          'flex w-full gap-4 rounded-2xl border bg-white p-3.5 text-left transition-colors hover:border-black/15',
          selected ? 'border-brand-500 ring-1 ring-brand-500' : 'border-black/[0.05]',
        )}
      >
        <OrderThumb order={order} className="size-24 sm:size-28" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-start justify-between gap-2">
            <span className="font-semibold text-slate-900">
              <span className="sr-only">Order </span>#{order.number}
            </span>
            <StagePill order={order} />
          </span>
          <span className="mt-0.5 truncate text-sm text-slate-600">
            Table {order.table_number}
            {order.table_code_verified && <span className="text-emerald-700"> · Code verified</span>}
          </span>
          <span className="line-clamp-1 text-sm text-slate-500">{orderItemsSummary(order.items)}</span>
          <span className="text-xs text-slate-400">{fmt.dateTime(order.created_at)}</span>
          <span className="mt-auto flex items-end justify-between gap-2 pt-2">
            <span className="flex flex-col">
              <span className="text-lg font-semibold leading-none text-slate-900 tabular-nums">{fmt.money(order.total)}</span>
              <span className="mt-1 text-xs text-slate-500">
                {order.payment_status === 'paid'
                  ? `Paid${order.payment_method === 'cash' ? ' · Cash' : order.payment_method === 'upi' ? ' · UPI' : ' · Online'}`
                  : order.payment_status === 'refunded'
                    ? 'Refunded'
                    : order.payment_claim
                      ? 'Customer says paid'
                      : order.status === 'cancelled'
                        ? ''
                        : 'Unpaid'}
              </span>
            </span>
            <span className="inline-flex items-center gap-0.5 text-sm font-medium text-slate-800">
              View details <ChevronRightIcon size={16} />
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

export default function Orders() {
  useDocumentTitle('Orders');
  const toast = useToast();
  const fmt = useFmt();
  const live = useLiveOrders();
  // On a wide screen (the same width at which the sidebar appears) an open order is shown beside the list, which makes room for it.
  const split = useMediaQuery('(min-width: 1024px)');
  const [params, setParams] = useSearchParams();

  const rawTab = params.get('status');
  const tab = TAB_VALUES.includes(rawTab) ? rawTab : 'active';
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(() => Number(params.get('order')) || null);
  // The notification panel takes the same place at the right edge: opening it closes the open order, and opening an order closes it.
  const { notificationsOpen, setNotificationsOpen } = useSidePanelSpace();
  useEffect(() => {
    if (notificationsOpen) setSelectedId(null);
  }, [notificationsOpen]);
  const openOrder = (id) => {
    setNotificationsOpen(false);
    setSelectedId(id);
  };
  const [fresh, setFresh] = useState(() => new Set());
  const term = useDebouncedValue(search.trim());

  // `?order=12` (from the dashboard) opens that order once; drop the parameter so Back/refresh don't reopen it.
  // Also when this page is already open (a notification opening an order): the parameter is read whenever it shows up.
  const orderParam = params.get('order');
  useEffect(() => {
    if (!orderParam) return;
    openOrder(Number(orderParam) || null);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('order');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderParam]);

  const setTab = (value) => {
    setParams(value === 'active' ? {} : { status: value }, { replace: true });
    setPage(1);
  };

  const key = `${tab}|${term}|${page}`;
  const q = useQuery(
    async () => apiPage('/api/admin/orders', { query: { status: tab === 'all' ? undefined : tab, q: term, page, per_page: PER_PAGE } }),
    [tab, term, page],
    { interval: REFRESH_MS },
  );
  const counts = useQuery(() => api('/api/admin/orders/counts'), [], { interval: 20_000 });

  // The app-wide watcher saw a new order: refresh now instead of waiting for the next timer tick.
  const arrivalsSeen = useRef(live.arrivals);
  useEffect(() => {
    if (live.arrivals === arrivalsSeen.current) return;
    arrivalsSeen.current = live.arrivals;
    q.reload();
    counts.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.arrivals]);

  const rows = q.data?.data;
  const total = Number(q.data?.meta?.total ?? 0);
  useClampPage(page, total, PER_PAGE, setPage, Boolean(q.data));

  // Highlight orders that appeared since the previous refresh of the same view (never on the first load of a view).
  const seen = useRef({ key: null, ids: new Set() });
  useEffect(() => {
    if (!rows) return;
    const ids = new Set(rows.map((o) => o.id));
    // Only page 1 can announce new arrivals; on later pages rows shift around as orders come in.
    if (seen.current.key === key && page === 1) {
      const added = rows.filter((o) => !seen.current.ids.has(o.id));
      if (added.length > 0) {
        const addedIds = added.map((o) => o.id);
        setFresh((prev) => new Set([...prev, ...addedIds]));
        if (tab === 'active' || tab === 'all' || tab === 'pending') {
          toast.info(added.length === 1 ? `New order #${added[0].number} from table ${added[0].table_number}.` : `${added.length} new orders.`);
        }
        setTimeout(
          () =>
            setFresh((prev) => {
              const next = new Set(prev);
              addedIds.forEach((id) => next.delete(id));
              return next;
            }),
          8000,
        );
      }
    }
    seen.current = { key, ids };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  const refreshAll = () => {
    q.reload();
    counts.reload();
    live.reload();
  };

  const tabs = TAB_VALUES.map((value) => ({ value, label: TAB_LABELS[value], count: counts.data ? counts.data[COUNT_KEY[value]] : undefined }));
  const [emptyTitle, emptyMessage] = EMPTY[tab];

  const docked = Boolean(selectedId) && split;
  useReserveSidePanelSpace(docked); // the page narrows to make room for the panel

  const detail = selectedId && (
    <OrderDetailModal
      key={selectedId}
      orderId={selectedId}
      docked={docked}
      onClose={() => setSelectedId(null)}
      onChanged={() => {
        q.reload();
        counts.reload();
        live.reload();
      }}
    />
  );

  return (
    <div className="@container">
      <PageHeader
        title="Orders"
        description="Accept orders, take payment and mark them complete."
        actions={
          <>
            <span className="hidden text-xs text-slate-500 sm:inline">{q.updatedAt ? `Updated ${fmt.clock(q.updatedAt)}` : 'Updating…'}</span>
            <Button variant="secondary" size="sm" icon={RefreshIcon} busy={q.refreshing} onClick={refreshAll}>
              Refresh
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-3 gap-2 @xl:gap-3 @4xl:grid-cols-6">
        {FIGURES.map(([k, label]) => (
          <StatTile key={k} label={label} value={counts.data ? counts.data[k] : '—'} />
        ))}
      </div>

      <SearchBox
        value={search}
        onChange={(v) => {
          setSearch(v);
          setPage(1);
        }}
        maxLength={30}
        placeholder="Search by table or order #"
        label="Search orders by table or order number"
        className="mb-3 @xl:max-w-md"
      />

      <Tabs idBase="orders" label="Order status" tabs={tabs} value={tab} onChange={setTab} className="mb-4" />

      <div role="tabpanel" id={panelId('orders', tab)} aria-labelledby={tabId('orders', tab)}>
        {q.loading && (
          <Card>
            <ListSkeleton label="Loading orders" />
          </Card>
        )}
        {!q.loading && !rows && (
          <Card>
            <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load orders" />
          </Card>
        )}

        {rows && q.error && (
          <div className="mb-3">
            <Alert tone="warning">
              Couldn&rsquo;t refresh ({q.error.message}). Showing orders as of {fmt.clock(q.updatedAt)}.
            </Alert>
          </div>
        )}

        {rows && rows.length === 0 && (
          <Card>
            <EmptyState
              icon={OrdersIcon}
              title={term ? 'No orders match' : emptyTitle}
              message={term ? `Nothing found for “${term}”. Try a table number or order number.` : emptyMessage}
              action={
                term ? (
                  <Button variant="secondary" onClick={() => setSearch('')}>
                    Clear search
                  </Button>
                ) : undefined
              }
            />
          </Card>
        )}

        {rows && rows.length > 0 && (
          <>
            <ul className="grid gap-3 @3xl:grid-cols-2 @7xl:grid-cols-3">
              {rows.map((order) => (
                <OrderCard key={order.id} order={order} fresh={fresh.has(order.id)} fmt={fmt} onOpen={openOrder} selected={order.id === selectedId} />
              ))}
            </ul>
            <Pagination page={page} perPage={PER_PAGE} total={total} onPageChange={setPage} className="mt-2 border-t-0 px-1" />
          </>
        )}
      </div>

      {/* On a wide screen the order opens in a panel fixed to the right edge of the screen (top to bottom); on a small one it slides in over the page. */}
      {docked ? createPortal(<div className="fixed inset-y-0 right-0 z-30 w-[22rem] xl:w-[26rem] print:hidden">{detail}</div>, document.body) : detail}
    </div>
  );
}

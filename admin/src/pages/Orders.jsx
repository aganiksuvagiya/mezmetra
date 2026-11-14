import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, PaymentBadge, StatusBadge } from '../components/Badge.jsx';
import { Button } from '../components/Button.jsx';
import { Card, PageHeader } from '../components/Card.jsx';
import { Alert, EmptyState, ErrorState } from '../components/EmptyState.jsx';
import { SearchInput } from '../components/Field.jsx';
import { OrdersIcon, RefreshIcon } from '../components/icons.jsx';
import ListSkeleton from '../components/ListSkeleton.jsx';
import Pagination from '../components/Pagination.jsx';
import { panelId, tabId, Tabs } from '../components/Tabs.jsx';
import { useToast } from '../components/Toast.jsx';
import { useLiveOrders } from '../context/LiveOrdersContext.jsx';
import { apiPage } from '../lib/api.js';
import { orderItemsSummary } from '../lib/format.js';
import { useClampPage, useDebouncedValue, useDocumentTitle, useQuery } from '../lib/hooks.js';
import { useFmt } from '../lib/useFmt.js';
import OrderDetailModal from './orders/OrderDetailModal.jsx';

const PER_PAGE = 20;
const REFRESH_MS = 8000;
const TAB_VALUES = ['active', 'completed', 'cancelled', 'all'];

const EMPTY = {
  active: ['No active orders', 'New orders from your tables will appear here automatically.'],
  completed: ['No completed orders yet', 'Orders you complete will be listed here.'],
  cancelled: ['No cancelled orders', 'Cancelled orders will be listed here.'],
  all: ['No orders yet', 'Once diners start ordering, every order will be listed here.'],
};

const countFor = async (status) => Number((await apiPage('/api/admin/orders', { query: { status, per_page: 1 } })).meta.total);

function OrderRow({ order, fresh, fmt, onOpen }) {
  return (
    <li className={fresh ? 'animate-flash' : undefined}>
      <button
        type="button"
        onClick={() => onOpen(order.id)}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 px-4 py-3.5 text-left hover:bg-slate-50 sm:px-5 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto_6rem] md:items-center"
      >
        <span className="block min-w-0">
          <span className="flex flex-wrap items-center gap-x-2 font-semibold text-slate-900">
            <span>
              <span className="sr-only">Order </span>#{order.id}
            </span>
            <span className="font-normal text-slate-500">Table {order.table_number}</span>
            {fresh && (
              <Badge tone="orange" dot={false}>
                New
              </Badge>
            )}
            {order.table_code_verified && (
              <Badge tone="green" dot={false}>
                Code verified
              </Badge>
            )}
          </span>
          <span className="block text-xs text-slate-500">{fmt.dateTime(order.created_at)}</span>
        </span>
        <span className="block font-semibold text-slate-900 tabular-nums md:order-last md:text-right">{fmt.money(order.total)}</span>
        <span className="col-span-2 line-clamp-2 text-sm text-slate-600 md:col-span-1">{orderItemsSummary(order.items)}</span>
        <span className="col-span-2 flex flex-wrap items-center gap-1.5 md:col-span-1">
          <StatusBadge status={order.status} ready={Boolean(order.ready_at)} />
          <PaymentBadge status={order.payment_status} method={order.payment_method} claimed={Boolean(order.payment_claim)} />
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
  const [params, setParams] = useSearchParams();

  const rawTab = params.get('status');
  const tab = TAB_VALUES.includes(rawTab) ? rawTab : 'active';
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(() => Number(params.get('order')) || null);
  const [fresh, setFresh] = useState(() => new Set());
  const term = useDebouncedValue(search.trim());

  // `?order=12` (from the dashboard) opens that order once; drop the parameter so Back/refresh don't reopen it.
  useEffect(() => {
    if (!params.has('order')) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('order');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTab = (value) => {
    setParams(value === 'active' ? {} : { status: value }, { replace: true });
    setPage(1);
  };

  const key = `${tab}|${term}|${page}`;
  const q = useQuery(
    async () => {
      const res = await apiPage('/api/admin/orders', { query: { status: tab === 'all' ? undefined : tab, q: term, page, per_page: PER_PAGE } });
      return res;
    },
    [tab, term, page],
    { interval: REFRESH_MS },
  );
  const counts = useQuery(
    async () => {
      const [active, completed, cancelled] = await Promise.all([countFor('active'), countFor('completed'), countFor('cancelled')]);
      return { active, completed, cancelled, all: active + completed + cancelled };
    },
    [],
    { interval: 20_000 },
  );

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
        if (tab === 'active' || tab === 'all') {
          toast.info(added.length === 1 ? `New order #${added[0].id} from table ${added[0].table_number}.` : `${added.length} new orders.`);
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

  const tabs = TAB_VALUES.map((value) => ({
    value,
    label: { active: 'Active', completed: 'Completed', cancelled: 'Cancelled', all: 'All' }[value],
    count: counts.data ? counts.data[value] : undefined,
  }));

  const [emptyTitle, emptyMessage] = EMPTY[tab];

  return (
    <>
      <PageHeader
        title="Orders"
        description="Accept orders, take payment and mark them complete."
        actions={
          <>
            <span className="text-xs text-slate-500">{q.updatedAt ? `Updated ${fmt.clock(q.updatedAt)}` : 'Updating…'}</span>
            <Button variant="secondary" size="sm" icon={RefreshIcon} busy={q.refreshing} onClick={refreshAll}>
              Refresh
            </Button>
          </>
        }
      />

      <Tabs idBase="orders" label="Order status" tabs={tabs} value={tab} onChange={setTab} className="mb-4" />

      <Card role="tabpanel" id={panelId('orders', tab)} aria-labelledby={tabId('orders', tab)}>
        <div className="border-b border-slate-100 p-3 sm:p-4">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search by table or order #"
            label="Search orders by table or order number"
            pending={search.trim() !== term}
            maxLength={30}
            className="sm:max-w-sm"
          />
        </div>

        {q.loading && <ListSkeleton label="Loading orders" />}
        {!q.loading && !rows && <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load orders" />}

        {rows && q.error && (
          <div className="px-4 pt-3">
            <Alert tone="warning">
              Couldn&rsquo;t refresh ({q.error.message}). Showing orders as of {fmt.clock(q.updatedAt)}.
            </Alert>
          </div>
        )}

        {rows && rows.length === 0 && (
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
        )}

        {rows && rows.length > 0 && (
          <>
            <ul className="divide-y divide-slate-100">
              {rows.map((order) => (
                <OrderRow key={order.id} order={order} fresh={fresh.has(order.id)} fmt={fmt} onOpen={setSelectedId} />
              ))}
            </ul>
            <Pagination page={page} perPage={PER_PAGE} total={total} onPageChange={setPage} />
          </>
        )}
      </Card>

      {selectedId && (
        <OrderDetailModal
          orderId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => {
            q.reload();
            counts.reload();
            live.reload();
          }}
        />
      )}
    </>
  );
}

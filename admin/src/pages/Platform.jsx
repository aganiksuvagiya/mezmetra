import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Badge } from '../components/Badge.jsx';
import { Button } from '../components/Button.jsx';
import { Card, PageHeader } from '../components/Card.jsx';
import { Alert, EmptyState, ErrorState } from '../components/EmptyState.jsx';
import { Input, SearchInput } from '../components/Field.jsx';
import { RefreshIcon, ShieldIcon } from '../components/icons.jsx';
import ListSkeleton from '../components/ListSkeleton.jsx';
import Modal from '../components/Modal.jsx';
import Pagination from '../components/Pagination.jsx';
import { panelId, tabId, Tabs } from '../components/Tabs.jsx';
import { useToast } from '../components/Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api, apiPage } from '../lib/api.js';
import { formatMoney, formatNumber } from '../lib/format.js';
import { useAction, useClampPage, useDebouncedValue, useDocumentTitle, useQuery } from '../lib/hooks.js';
import { useFmt } from '../lib/useFmt.js';

const PER_PAGE = 20;
const TABS = [
  ['all', 'All'],
  ['active', 'Active'],
  ['suspended', 'Suspended'],
];

function Stat({ label, value, note }) {
  return (
    <Card className="p-4">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-xs text-slate-500">{note}</p>}
    </Card>
  );
}

/** Asks for an optional reason (shown to the restaurant when it tries to sign in), then suspends. */
function SuspendDialog({ restaurant, onClose, onDone }) {
  const [run, busy] = useAction();
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);

  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      setError(null);
      try {
        const updated = await api(`/api/platform/restaurants/${restaurant.id}`, { method: 'PATCH', body: { suspended: true, reason: reason.trim() || undefined } });
        onDone(updated);
      } catch (e) {
        setError(e.message || 'Something went wrong. Please try again.');
      }
    });
  };

  return (
    <Modal
      role="alertdialog"
      size="sm"
      title={`Suspend ${restaurant.name}?`}
      description="They won't be able to sign in, and their tables stop taking orders, until you reactivate them. Their data is kept."
      onClose={onClose}
      dismissible={!busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </Button>
          <Button type="submit" variant="danger" busy={busy}>
            Suspend
          </Button>
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      <Input
        label="Reason (optional)"
        hint="They see this when they try to sign in."
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={200}
        placeholder="e.g. unpaid invoice"
        autoComplete="off"
        wrapperClassName={error ? 'mt-3' : undefined}
      />
    </Modal>
  );
}

function RestaurantRow({ r, fmt, onSuspend, onReactivate, busy }) {
  const suspended = r.status === 'suspended';
  return (
    <li className="grid grid-cols-1 gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-slate-900">
          <span className="truncate">{r.name}</span>
          {r.is_platform_owner && <Badge tone="blue" dot={false}>Platform owner</Badge>}
          <Badge tone={suspended ? 'red' : 'green'}>{suspended ? 'Suspended' : 'Active'}</Badge>
        </p>
        <p className="truncate text-sm text-slate-500">{r.email}</p>
        <p className="text-xs text-slate-500">Joined {fmt.dateTime(r.created_at)}</p>
        {suspended && (
          <p className="mt-1 text-xs text-red-700">
            Suspended {fmt.dateTime(r.suspended_at)}
            {r.suspended_reason ? `: ${r.suspended_reason}` : ''}
          </p>
        )}
      </div>

      <div className="space-y-0.5 text-sm text-slate-600">
        <p>
          <span className="font-semibold text-slate-900 tabular-nums">{formatNumber(r.orders_30d)}</span> {r.orders_30d === 1 ? 'order' : 'orders'} in 30 days ·{' '}
          <span className="font-semibold text-slate-900 tabular-nums">{formatMoney(r.revenue_total)}</span> paid in total
        </p>
        <p>
          {formatNumber(r.tables)} {r.tables === 1 ? 'table' : 'tables'} · {formatNumber(r.items)} {r.items === 1 ? 'dish' : 'dishes'} ·{' '}
          {r.last_order_at ? `last order ${fmt.dateTime(r.last_order_at)}` : 'no orders yet'}
        </p>
        <p className="pt-1">{r.upi_ready ? <Badge tone="green" dot={false}>UPI ready</Badge> : <Badge tone="amber" dot={false}>No UPI ID yet</Badge>}</p>
      </div>

      <div className="md:text-right">
        {suspended ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => onReactivate(r)}>
            Reactivate
          </Button>
        ) : (
          <Button variant="danger-outline" size="sm" disabled={busy || r.is_platform_owner} onClick={() => onSuspend(r)} title={r.is_platform_owner ? "A platform owner's account can't be suspended" : undefined}>
            Suspend
          </Button>
        )}
      </div>
    </li>
  );
}

export default function Platform() {
  useDocumentTitle('Platform');
  const { vendor } = useAuth();
  const toast = useToast();
  const fmt = useFmt();
  const [reactivate, busy] = useAction();

  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [suspending, setSuspending] = useState(null);
  const term = useDebouncedValue(search.trim());

  const isOwner = Boolean(vendor?.is_super_admin);
  const overview = useQuery(() => api('/api/platform/overview'), [], { interval: 60_000, enabled: isOwner });
  const list = useQuery(
    () => apiPage('/api/platform/restaurants', { query: { status: tab === 'all' ? undefined : tab, q: term, page, per_page: PER_PAGE } }),
    [tab, term, page],
    { interval: 30_000, enabled: isOwner },
  );
  const rows = list.data?.data;
  const total = Number(list.data?.meta?.total ?? 0);
  useClampPage(page, total, PER_PAGE, setPage, Boolean(list.data));

  // Only the platform owner has this page (the API refuses everyone else too).
  if (!isOwner) return <Navigate to="/" replace />;

  const refreshAll = () => {
    list.reload();
    overview.reload();
  };

  const changed = (updated, message) => {
    toast.success(message);
    setSuspending(null);
    refreshAll();
    return updated;
  };

  const doReactivate = (r) =>
    reactivate(async () => {
      try {
        await api(`/api/platform/restaurants/${r.id}`, { method: 'PATCH', body: { suspended: false } });
        changed(null, `${r.name} is active again.`);
      } catch (e) {
        toast.error(e.message || "Couldn't reactivate. Please try again.");
      }
    });

  const o = overview.data;
  const tabs = TABS.map(([value, label]) => ({
    value,
    label,
    count: o ? { all: o.restaurants.total, active: o.restaurants.active, suspended: o.restaurants.suspended }[value] : undefined,
  }));

  return (
    <>
      <PageHeader
        title="Platform"
        description="Every restaurant on the product. Suspend one to stop it signing in and taking orders."
        actions={
          <>
            <span className="text-xs text-slate-500">{list.updatedAt ? `Updated ${fmt.clock(list.updatedAt)}` : 'Updating…'}</span>
            <Button variant="secondary" size="sm" icon={RefreshIcon} busy={list.refreshing} onClick={refreshAll}>
              Refresh
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:mb-6 sm:gap-4 lg:grid-cols-4">
        <Stat label="Restaurants" value={o ? formatNumber(o.restaurants.total) : '—'} note={o ? `${formatNumber(o.restaurants.new_30d)} new in 30 days` : undefined} />
        <Stat label="Suspended" value={o ? formatNumber(o.restaurants.suspended) : '—'} note={o ? `${formatNumber(o.restaurants.active)} active` : undefined} />
        <Stat label="Orders · 30 days" value={o ? formatNumber(o.orders_30d) : '—'} />
        <Stat label="Paid revenue · 30 days" value={o ? formatMoney(o.revenue_30d) : '—'} note="Across all restaurants" />
      </div>

      <Tabs
        idBase="platform"
        label="Restaurant status"
        tabs={tabs}
        value={tab}
        onChange={(v) => {
          setTab(v);
          setPage(1);
        }}
        className="mb-4"
      />

      <Card role="tabpanel" id={panelId('platform', tab)} aria-labelledby={tabId('platform', tab)}>
        <div className="border-b border-slate-100 p-3 sm:p-4">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search by restaurant name or email"
            label="Search restaurants by name or email"
            pending={search.trim() !== term}
            maxLength={60}
            className="sm:max-w-sm"
          />
        </div>

        {list.loading && <ListSkeleton label="Loading restaurants" />}
        {!list.loading && !rows && <ErrorState error={list.error} onRetry={list.reload} title="Couldn't load restaurants" />}

        {rows && list.error && (
          <div className="px-4 pt-3">
            <Alert tone="warning">
              Couldn&rsquo;t refresh ({list.error.message}). Showing the list as of {fmt.clock(list.updatedAt)}.
            </Alert>
          </div>
        )}

        {rows && rows.length === 0 && (
          <EmptyState
            icon={ShieldIcon}
            title={term ? 'No restaurants match' : tab === 'suspended' ? 'Nobody is suspended' : 'No restaurants yet'}
            message={term ? `Nothing found for “${term}”.` : tab === 'suspended' ? 'Restaurants you suspend will be listed here.' : 'Restaurants that sign up will appear here.'}
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
              {rows.map((r) => (
                <RestaurantRow key={r.id} r={r} fmt={fmt} busy={busy} onSuspend={setSuspending} onReactivate={doReactivate} />
              ))}
            </ul>
            <Pagination page={page} perPage={PER_PAGE} total={total} onPageChange={setPage} />
          </>
        )}
      </Card>

      {suspending && (
        <SuspendDialog restaurant={suspending} onClose={() => setSuspending(null)} onDone={(updated) => changed(updated, `${suspending.name} is suspended.`)} />
      )}
    </>
  );
}

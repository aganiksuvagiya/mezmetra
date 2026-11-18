import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/Badge.jsx';
import { Button } from '../../components/Button.jsx';
import { Card, PageHeader } from '../../components/Card.jsx';
import { Alert, EmptyState, ErrorState } from '../../components/EmptyState.jsx';
import { SearchInput } from '../../components/Field.jsx';
import { OrdersIcon, RefreshIcon, ShieldIcon, TrendingIcon, UsersIcon } from '../../components/icons.jsx';
import ListSkeleton from '../../components/ListSkeleton.jsx';
import Pagination from '../../components/Pagination.jsx';
import { panelId, tabId, Tabs } from '../../components/Tabs.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { api, apiPage } from '../../lib/api.js';
import { cx } from '../../lib/cx.js';
import { formatMoney, formatNumber, timeAgo } from '../../lib/format.js';
import { useAction, useClampPage, useDebouncedValue, useDocumentTitle, useQuery } from '../../lib/hooks.js';
import { useFmt } from '../../lib/useFmt.js';
import RestaurantAvatar from './RestaurantAvatar.jsx';
import SuspendDialog from './SuspendDialog.jsx';

const PER_PAGE = 20;
const TABS = [
  ['all', 'All'],
  ['active', 'Active'],
  ['suspended', 'Suspended'],
];

function Stat({ icon: Icon, label, value, note, tone = 'brand' }) {
  const tiles = { brand: 'bg-brand-50 text-brand-600', emerald: 'bg-emerald-50 text-emerald-600', red: 'bg-red-50 text-red-600', sky: 'bg-sky-50 text-sky-600' };
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-lg', tiles[tone])}>
          <Icon size={20} />
        </span>
        <p className="text-sm font-medium text-slate-500">{label}</p>
      </div>
      <p className="mt-3 text-3xl font-bold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {note && <p className="mt-1 text-sm text-slate-500">{note}</p>}
    </Card>
  );
}

function Metric({ label, value }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}

function RestaurantRow({ r, fmt, onSuspend, onReactivate, busy }) {
  const { vendor } = useAuth();
  const upiOffered = vendor?.payment_methods?.includes('upi') ?? true; // with UPI switched off for the product, "No UPI ID yet" is noise
  const suspended = r.status === 'suspended';
  return (
    // The restaurant's name is a link stretched over the whole row, so the row opens its page; the buttons sit above it.
    <li className={cx('relative transition-colors hover:bg-slate-50', suspended && 'bg-slate-50/70')}>
      <div className="grid gap-x-5 gap-y-3 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_auto] lg:items-center">
        <div className="flex min-w-0 items-center gap-3.5">
          <RestaurantAvatar name={r.name} suspended={suspended} />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-slate-900">
              <Link to={`/owner/restaurants/${r.id}`} className="truncate rounded-sm after:absolute after:inset-0 hover:underline">
                {r.name}
              </Link>
              {r.is_platform_owner && <Badge tone="blue" dot={false}>Platform owner</Badge>}
              <Badge tone={suspended ? 'red' : 'green'}>{suspended ? 'Suspended' : 'Active'}</Badge>
              {upiOffered && !suspended && (r.upi_ready ? <Badge tone="green" dot={false}>UPI ready</Badge> : <Badge tone="amber" dot={false}>No UPI ID yet</Badge>)}
            </p>
            <p className="truncate text-sm text-slate-500">{r.email}</p>
            {suspended ? (
              <p className="text-xs text-red-700">
                Suspended {fmt.dateTime(r.suspended_at)}
                {r.suspended_reason ? `: ${r.suspended_reason}` : ''}
              </p>
            ) : (
              <p className="truncate text-xs text-slate-400">
                Joined {fmt.dateTime(r.created_at)} · {formatNumber(r.tables)} {r.tables === 1 ? 'table' : 'tables'} · {formatNumber(r.items)} {r.items === 1 ? 'dish' : 'dishes'}
              </p>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-x-4">
          <Metric label="Orders (30d)" value={formatNumber(r.orders_30d)} />
          <Metric label="Paid in total" value={formatMoney(r.revenue_total)} />
          <Metric label="Last order" value={r.last_order_at ? timeAgo(r.last_order_at) : 'None yet'} />
        </dl>

        <div className="relative z-10 flex items-center gap-2">
          <Link
            to={`/owner/restaurants/${r.id}`}
            className="inline-flex h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 shadow-xs hover:bg-slate-50"
          >
            Manage
          </Link>
          {suspended ? (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onReactivate(r)}>
              Reactivate
            </Button>
          ) : (
            <Button
              variant="danger-outline"
              size="sm"
              disabled={busy || r.is_platform_owner}
              onClick={() => onSuspend(r)}
              title={r.is_platform_owner ? "A platform owner's account can't be suspended" : undefined}
            >
              Suspend
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

/** The owner console's home: how the product is doing, and every restaurant on it. */
export default function Restaurants() {
  useDocumentTitle('Owner console');
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

  const refreshAll = () => {
    list.reload();
    overview.reload();
  };

  const changed = (message) => {
    toast.success(message);
    setSuspending(null);
    refreshAll();
  };

  const doReactivate = (r) =>
    reactivate(async () => {
      try {
        await api(`/api/platform/restaurants/${r.id}`, { method: 'PATCH', body: { suspended: false } });
        changed(`${r.name} is active again.`);
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
        title="Restaurants"
        description="Every restaurant on MezMitra. Open one to see its details, help it, or suspend it."
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
        <Stat icon={UsersIcon} label="Restaurants" value={o ? formatNumber(o.restaurants.total) : '—'} note={o ? `${formatNumber(o.restaurants.new_30d)} new in 30 days` : undefined} />
        <Stat
          icon={ShieldIcon}
          tone={o && o.restaurants.suspended > 0 ? 'red' : 'emerald'}
          label="Suspended"
          value={o ? formatNumber(o.restaurants.suspended) : '—'}
          note={o ? `${formatNumber(o.restaurants.active)} active` : undefined}
        />
        <Stat icon={OrdersIcon} tone="sky" label="Orders · 30 days" value={o ? formatNumber(o.orders_30d) : '—'} note="Across all restaurants" />
        <Stat icon={TrendingIcon} tone="emerald" label="Paid revenue · 30 days" value={o ? formatMoney(o.revenue_30d) : '—'} note="Across all restaurants" />
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

      <Card role="tabpanel" id={panelId('platform', tab)} aria-labelledby={tabId('platform', tab)} className="overflow-hidden">
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

      {suspending && <SuspendDialog restaurant={suspending} onClose={() => setSuspending(null)} onDone={() => changed(`${suspending.name} is suspended.`)} />}
    </>
  );
}

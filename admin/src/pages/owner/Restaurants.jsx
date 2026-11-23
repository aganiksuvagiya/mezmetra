import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRightIcon, SearchIcon } from '../../components/icons.jsx';
import Pagination from '../../components/Pagination.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { api, apiPage } from '../../lib/api.js';
import { formatMoney, formatNumber, timeAgo } from '../../lib/format.js';
import { useClampPage, useDebouncedValue, useDocumentTitle, useQuery } from '../../lib/hooks.js';
import { useFmt } from '../../lib/useFmt.js';
import AddRestaurantDialog from './AddRestaurantDialog.jsx';
import { Avatar, buttonClass, Figures, Label, Panel, Segmented, Title } from './ui.jsx';

const PER_PAGE = 20;

function Metric({ label, value }) {
  return (
    <div className="w-24 text-right">
      <dt className="k-l3 text-[0.6875rem] font-semibold uppercase tracking-wide">{label}</dt>
      <dd className="mt-0.5 truncate text-[0.875rem] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function RestaurantRow({ r, fmt }) {
  const suspended = r.status === 'suspended';
  return (
    <li>
      <Link to={`/owner/restaurants/${r.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-black/[0.03] active:bg-black/[0.06]">
        <Avatar name={r.name} muted={suspended} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`truncate text-[0.9375rem] font-semibold ${suspended ? 'k-l2' : ''}`}>{r.name}</span>
            {r.is_platform_owner && <Label tone="blue">Platform owner</Label>}
            {suspended && <Label tone="red">Suspended</Label>}
          </p>
          <p className="k-l2 truncate text-[0.8125rem]">{r.email}</p>
          <p className="k-l3 truncate text-[0.8125rem]">
            {suspended
              ? `Suspended ${fmt.dateTime(r.suspended_at)}${r.suspended_reason ? `: ${r.suspended_reason}` : ''}`
              : `Joined ${fmt.dateTime(r.created_at)} · ${formatNumber(r.tables)} ${r.tables === 1 ? 'table' : 'tables'} · ${formatNumber(r.items)} ${r.items === 1 ? 'dish' : 'dishes'}`}
          </p>
        </div>
        <dl className="hidden gap-4 md:flex">
          <Metric label="Orders · 30d" value={formatNumber(r.orders_30d)} />
          <Metric label="Paid in total" value={formatMoney(r.revenue_total)} />
          <Metric label="Last order" value={r.last_order_at ? timeAgo(r.last_order_at) : 'None yet'} />
        </dl>
        <ChevronRightIcon size={16} className="k-l3" />
      </Link>
    </li>
  );
}

/** The owner console's home: how the product is doing, and every restaurant on it. */
export default function Restaurants() {
  useDocumentTitle('Owner console');
  const { vendor } = useAuth();
  const fmt = useFmt();
  const navigate = useNavigate();

  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
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

  const o = overview.data;
  const counts = o ? { all: o.restaurants.total, active: o.restaurants.active, suspended: o.restaurants.suspended } : {};

  return (
    <>
      <Title
        title="Restaurants"
        description="Every restaurant on MezMitra."
        actions={
          <>
            <span className="k-l3 mr-1 hidden text-[0.8125rem] sm:inline">{list.updatedAt ? `Updated ${fmt.clock(list.updatedAt)}` : ''}</span>
            <button type="button" className={buttonClass.gray} onClick={refreshAll} disabled={list.refreshing}>
              Refresh
            </button>
            <button type="button" className={buttonClass.primary} onClick={() => setAdding(true)}>
              Add restaurant
            </button>
          </>
        }
      />

      <Figures
        items={[
          { label: 'Restaurants', value: o ? formatNumber(o.restaurants.total) : '—', note: o ? `${formatNumber(o.restaurants.new_30d)} new in 30 days` : undefined },
          { label: 'Suspended', value: o ? formatNumber(o.restaurants.suspended) : '—', tone: o && o.restaurants.suspended > 0 ? 'k-red' : '', note: o ? `${formatNumber(o.restaurants.active)} active` : undefined },
          { label: 'Orders · 30 days', value: o ? formatNumber(o.orders_30d) : '—', note: 'Across all restaurants' },
          { label: 'Paid · 30 days', value: o ? formatMoney(o.revenue_30d) : '—', note: 'Across all restaurants' },
        ]}
      />

      <div className="mb-3 mt-6 flex flex-wrap items-center gap-3">
        <Segmented
          label="Restaurant status"
          value={tab}
          onChange={(v) => {
            setTab(v);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'active', label: 'Active', count: counts.active },
            { value: 'suspended', label: 'Suspended', count: counts.suspended },
          ]}
        />
        <label className="k-fill flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 sm:max-w-xs">
          <SearchIcon size={16} className="k-l3" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            maxLength={60}
            placeholder="Search"
            aria-label="Search restaurants by name or email"
            className="min-w-0 flex-1 bg-transparent text-[0.875rem] outline-none placeholder:text-[color:var(--k-label3)]"
          />
        </label>
      </div>

      <Panel>
        {list.loading && (
          <ul className="k-divide" role="status" aria-label="Loading restaurants">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-4">
                <span className="k-fill size-9 shrink-0 animate-pulse rounded-lg" />
                <span className="flex-1 space-y-2">
                  <span className="k-fill block h-3.5 w-40 animate-pulse rounded" />
                  <span className="k-fill block h-3 w-56 animate-pulse rounded" />
                </span>
              </li>
            ))}
          </ul>
        )}

        {!list.loading && !rows && (
          <div role="alert" className="px-4 py-12 text-center">
            <p className="text-[0.9375rem] font-semibold">Couldn&rsquo;t load restaurants</p>
            <p className="k-l2 mt-1 text-[0.875rem]">{list.error?.message || 'Please try again.'}</p>
            <button type="button" className={`${buttonClass.gray} mt-3`} onClick={list.reload}>
              Try again
            </button>
          </div>
        )}

        {rows && list.error && <p className="k-pill-orange px-4 py-2 text-[0.8125rem]">Couldn&rsquo;t refresh ({list.error.message}). Showing the list as of {fmt.clock(list.updatedAt)}.</p>}

        {rows && rows.length === 0 && (
          <div className="px-4 py-12 text-center">
            <p className="text-[0.9375rem] font-semibold">{term ? 'No restaurants match' : tab === 'suspended' ? 'Nobody is suspended' : 'No restaurants yet'}</p>
            <p className="k-l2 mt-1 text-[0.875rem]">
              {term ? `Nothing found for “${term}”.` : tab === 'suspended' ? 'Restaurants you suspend will be listed here.' : 'Add the first restaurant to get started.'}
            </p>
            {term ? (
              <button type="button" className={`${buttonClass.gray} mt-3`} onClick={() => setSearch('')}>
                Clear search
              </button>
            ) : (
              tab === 'all' && (
                <button type="button" className={`${buttonClass.primary} mt-3`} onClick={() => setAdding(true)}>
                  Add restaurant
                </button>
              )
            )}
          </div>
        )}

        {rows && rows.length > 0 && (
          <>
            <ul className="k-divide">
              {rows.map((r) => (
                <RestaurantRow key={r.id} r={r} fmt={fmt} />
              ))}
            </ul>
            <Pagination page={page} perPage={PER_PAGE} total={total} onPageChange={setPage} />
          </>
        )}
      </Panel>

      {adding && (
        <AddRestaurantDialog
          onClose={() => setAdding(false)}
          onCreated={() => {
            setTab('all');
            setSearch('');
            setPage(1);
            refreshAll();
          }}
          onOpen={(id) => navigate(`/owner/restaurants/${id}`)}
        />
      )}
    </>
  );
}

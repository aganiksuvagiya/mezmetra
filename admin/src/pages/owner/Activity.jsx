import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SearchIcon } from '../../components/icons.jsx';
import Pagination from '../../components/Pagination.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { apiPage } from '../../lib/api.js';
import { timeAgo } from '../../lib/format.js';
import { useClampPage, useDebouncedValue, useDocumentTitle, useQuery } from '../../lib/hooks.js';
import { useFmt } from '../../lib/useFmt.js';
import { ACTIVITY_FILTERS, ACTIVITY_LABELS, activityNote } from './activity.js';
import { buttonClass, Label, Panel, Title } from './ui.jsx';

const PER_PAGE = 30;
// One tint per kind of action, so a glance down the list tells what happened: green = added, red = removed or cut off, blue = changed.
const TONES = { create: 'green', update: 'blue', suspend: 'red', reactivate: 'green', set_password: 'orange', login_as: 'gray', delete: 'red' };

/** Everything the owner did across all restaurants (add, change, suspend, set a password, delete), newest first. */
export default function Activity() {
  useDocumentTitle('Activity · Owner console');
  const { vendor } = useAuth();
  const fmt = useFmt();
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebouncedValue(search.trim());
  const isOwner = Boolean(vendor?.is_super_admin);

  const list = useQuery(
    () => apiPage('/api/platform/activity', { query: { action: action || undefined, q: term || undefined, page, per_page: PER_PAGE } }),
    [action, term, page],
    { interval: 30_000, enabled: isOwner },
  );
  const rows = list.data?.data;
  const total = Number(list.data?.meta?.total ?? 0);
  useClampPage(page, total, PER_PAGE, setPage, Boolean(list.data));

  return (
    <>
      <Title
        title="Activity"
        description="Everything done from the owner console, across all restaurants."
        actions={
          <>
            <span className="k-l3 mr-1 hidden text-[0.8125rem] sm:inline">{list.updatedAt ? `Updated ${fmt.clock(list.updatedAt)}` : ''}</span>
            <button type="button" className={buttonClass.gray} onClick={list.reload} disabled={list.refreshing}>
              Refresh
            </button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
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
            aria-label="Search activity by restaurant name or email"
            className="min-w-0 flex-1 bg-transparent text-[0.875rem] outline-none placeholder:text-[color:var(--k-label3)]"
          />
        </label>
        <select
          aria-label="Kind of action"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
          className="k-fill k-l1 h-9 rounded-lg px-3 text-[0.875rem] font-medium outline-none"
        >
          {ACTIVITY_FILTERS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <Panel>
        {list.loading && (
          <ul className="k-divide" role="status" aria-label="Loading activity">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="space-y-2 px-4 py-4">
                <span className="k-fill block h-3.5 w-48 animate-pulse rounded" />
                <span className="k-fill block h-3 w-72 animate-pulse rounded" />
              </li>
            ))}
          </ul>
        )}

        {!list.loading && !rows && (
          <div role="alert" className="px-4 py-12 text-center">
            <p className="text-[0.9375rem] font-semibold">Couldn&rsquo;t load the activity</p>
            <p className="k-l2 mt-1 text-[0.875rem]">{list.error?.message || 'Please try again.'}</p>
            <button type="button" className={`${buttonClass.gray} mt-3`} onClick={list.reload}>
              Try again
            </button>
          </div>
        )}

        {rows && list.error && <p className="k-pill-orange px-4 py-2 text-[0.8125rem]">Couldn&rsquo;t refresh ({list.error.message}). Showing the list as of {fmt.clock(list.updatedAt)}.</p>}

        {rows && rows.length === 0 && (
          <div className="px-4 py-12 text-center">
            <p className="text-[0.9375rem] font-semibold">{term || action ? 'Nothing matches' : 'No activity yet'}</p>
            <p className="k-l2 mt-1 text-[0.875rem]">{term || action ? 'Try another search or action.' : 'Adding, changing, suspending or deleting a restaurant will be recorded here.'}</p>
            {(term || action) && (
              <button
                type="button"
                className={`${buttonClass.gray} mt-3`}
                onClick={() => {
                  setSearch('');
                  setAction('');
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {rows && rows.length > 0 && (
          <>
            <ul className="k-divide">
              {rows.map((a) => {
                const note = activityNote(a);
                return (
                  <li key={a.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.9375rem]">
                        <Label tone={TONES[a.action] ?? 'gray'}>{ACTIVITY_LABELS[a.action] ?? a.action}</Label>
                        {a.restaurant.id ? (
                          <Link to={`/owner/restaurants/${a.restaurant.id}`} className="k-blue truncate font-semibold">
                            {a.restaurant.name}
                          </Link>
                        ) : (
                          <span className="truncate font-semibold" title="This restaurant no longer exists">
                            {a.restaurant.name} <span className="k-l3 font-normal">(gone)</span>
                          </span>
                        )}
                      </p>
                      <p className="k-l2 mt-0.5 break-all text-[0.8125rem]">{a.restaurant.email}</p>
                      {note && <p className="mt-1 break-words text-[0.875rem]">{note}</p>}
                    </div>
                    <p className="k-l3 text-[0.8125rem]" title={fmt.dateTime(a.at)}>
                      {a.by} · {timeAgo(a.at)}
                    </p>
                  </li>
                );
              })}
            </ul>
            <Pagination page={page} perPage={PER_PAGE} total={total} onPageChange={setPage} />
          </>
        )}
      </Panel>
    </>
  );
}

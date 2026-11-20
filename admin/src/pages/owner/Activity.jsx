import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/Badge.jsx';
import { Button } from '../../components/Button.jsx';
import { Card, PageHeader } from '../../components/Card.jsx';
import { Alert, EmptyState, ErrorState } from '../../components/EmptyState.jsx';
import { SearchInput, Select } from '../../components/Field.jsx';
import { RefreshIcon, ShieldIcon } from '../../components/icons.jsx';
import ListSkeleton from '../../components/ListSkeleton.jsx';
import Pagination from '../../components/Pagination.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { apiPage } from '../../lib/api.js';
import { timeAgo } from '../../lib/format.js';
import { useClampPage, useDebouncedValue, useDocumentTitle, useQuery } from '../../lib/hooks.js';
import { useFmt } from '../../lib/useFmt.js';
import { ACTIVITY_FILTERS, ACTIVITY_LABELS, activityNote } from './activity.js';

const PER_PAGE = 30;
// One colour per kind of action, so a glance down the list tells what happened: green = added, red = removed / cut off, blue = changed.
const TONES = { create: 'green', update: 'blue', suspend: 'red', reactivate: 'green', set_password: 'amber', login_as: 'amber', delete: 'red' };

/** Everything the owner did across all restaurants (add, change, suspend, set a password, log in as, delete), newest first. */
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
      <PageHeader
        title="Activity"
        description="Everything done from the owner console, across all restaurants. Newest first."
        actions={
          <>
            <span className="text-xs text-slate-500">{list.updatedAt ? `Updated ${fmt.clock(list.updatedAt)}` : 'Updating…'}</span>
            <Button variant="secondary" size="sm" icon={RefreshIcon} busy={list.refreshing} onClick={list.reload}>
              Refresh
            </Button>
          </>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-3 sm:flex-row sm:items-center sm:p-4">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search by restaurant or email"
            label="Search activity by restaurant name or email"
            pending={search.trim() !== term}
            maxLength={60}
            className="sm:max-w-sm sm:flex-1"
          />
          <Select
            label="Kind of action"
            labelHidden
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
            wrapperClassName="sm:w-52"
          >
            {ACTIVITY_FILTERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>

        {list.loading && <ListSkeleton label="Loading activity" />}
        {!list.loading && !rows && <ErrorState error={list.error} onRetry={list.reload} title="Couldn't load the activity" />}

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
            title={term || action ? 'Nothing matches' : 'No activity yet'}
            message={term || action ? 'Try another search or action.' : 'Adding, changing, suspending or deleting a restaurant will be recorded here.'}
            action={
              term || action ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setAction('');
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        )}

        {rows && rows.length > 0 && (
          <>
            <ul className="divide-y divide-slate-100">
              {rows.map((a) => {
                const note = activityNote(a);
                const label = ACTIVITY_LABELS[a.action] ?? a.action;
                return (
                  <li key={a.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
                    <div className="min-w-0 flex-1 basis-60">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-slate-900">
                        <Badge tone={TONES[a.action] ?? 'slate'} dot={false}>
                          {label}
                        </Badge>
                        {a.restaurant.id ? (
                          <Link to={`/owner/restaurants/${a.restaurant.id}`} className="truncate rounded-sm hover:underline">
                            {a.restaurant.name}
                          </Link>
                        ) : (
                          <span className="truncate" title="This restaurant no longer exists">
                            {a.restaurant.name} <span className="font-normal text-slate-400">(gone)</span>
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 break-all text-xs text-slate-500">{a.restaurant.email}</p>
                      {note && <p className="mt-1 break-words text-sm text-slate-600">{note}</p>}
                    </div>
                    <p className="text-xs text-slate-400" title={fmt.dateTime(a.at)}>
                      {a.by} · {timeAgo(a.at)}
                    </p>
                  </li>
                );
              })}
            </ul>
            <Pagination page={page} perPage={PER_PAGE} total={total} onPageChange={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

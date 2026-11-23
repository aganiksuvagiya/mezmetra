import { useMemo, useState } from 'react';
import { AvailabilityBadge } from '../components/Badge.jsx';
import { Button, IconButton } from '../components/Button.jsx';
import { Card, PageHeader } from '../components/Card.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { Alert, EmptyState, ErrorState } from '../components/EmptyState.jsx';
import FilterSelect from '../components/FilterSelect.jsx';
import { OrdersIcon, PencilIcon, PlusIcon, QrIcon, RefreshIcon, TableIcon, TrashIcon, UsersIcon } from '../components/icons.jsx';
import ListSkeleton from '../components/ListSkeleton.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { Skeleton } from '../components/Spinner.jsx';
import StatTile from '../components/StatTile.jsx';
import { panelId, tabId, Tabs } from '../components/Tabs.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, apiPage } from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { formatNumber, plural } from '../lib/format.js';
import { useDocumentTitle, useQuery } from '../lib/hooks.js';
import { useFmt } from '../lib/useFmt.js';
import QrModal from './tables/QrModal.jsx';
import TableBillModal from './tables/TableBillModal.jsx';
import TableFormModal from './tables/TableFormModal.jsx';

const ALL = 'all';
const TABS = [
  [ALL, 'All'],
  ['available', 'Available'],
  ['occupied', 'Occupied'],
  ['maintenance', 'Maintenance'],
];

export default function Tables() {
  useDocumentTitle('Tables');
  const toast = useToast();
  const fmt = useFmt();
  const [search, setSearch] = useState('');
  const [area, setArea] = useState('');
  const [availability, setAvailability] = useState(ALL);
  const [editing, setEditing] = useState(null); // null | 'new' | table
  const [qrFor, setQrFor] = useState(null);
  const [billFor, setBillFor] = useState(null);
  const [deleting, setDeleting] = useState(null);

  // The whole (small, unpaginated) list is loaded once and filtered here, so the figures always describe every
  // table and typing in the search box never flashes stale or empty results. Occupancy refreshes every 30s.
  const q = useQuery(() => apiPage('/api/admin/tables'), [], { interval: 30_000 });
  const tables = q.data?.data;
  const meta = q.data?.meta ?? {};

  const areas = useMemo(() => [...new Set((tables ?? []).map((t) => t.area))].sort((a, b) => a.localeCompare(b)), [tables]);

  const visible = useMemo(() => {
    if (!tables) return null;
    const term = search.trim().toLowerCase();
    return tables.filter(
      (t) =>
        (!term || t.number.toLowerCase().includes(term)) &&
        (!area || t.area.toLowerCase() === area.toLowerCase()) &&
        (availability === ALL || t.availability === availability),
    );
  }, [tables, search, area, availability]);

  // How many tables are in each state (ignoring the search and area), for the tabs.
  const counts = useMemo(() => {
    const c = { [ALL]: tables?.length ?? 0 };
    for (const [value] of TABS.slice(1)) c[value] = (tables ?? []).filter((t) => t.availability === value).length;
    return c;
  }, [tables]);

  const filtered = Boolean(search.trim() || area || availability !== ALL);
  const clearFilters = () => {
    setSearch('');
    setArea('');
    setAvailability(ALL);
  };

  return (
    <div className="@container">
      <PageHeader
        title="Tables"
        description="Every table has its own QR code for ordering."
        actions={
          <>
            <Button variant="secondary" icon={RefreshIcon} busy={q.refreshing} onClick={q.reload}>
              Refresh
            </Button>
            <Button icon={PlusIcon} onClick={() => setEditing('new')}>
              Add table
            </Button>
          </>
        }
      />

      {q.loading ? (
        <div className="mb-4 grid grid-cols-3 gap-2 @xl:gap-3" role="status" aria-label="Loading summary">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : (
        tables && (
          <div className="mb-4 grid grid-cols-3 gap-2 @xl:gap-3">
            <StatTile label="Tables" value={formatNumber(meta.total ?? tables.length)} />
            <StatTile label="Total seats" value={formatNumber(meta.total_capacity ?? 0)} />
            <StatTile label="Occupancy" value={`${meta.occupancy_percent ?? 0}%`} note={`${meta.occupied_tables ?? 0} of ${plural(meta.active_tables ?? 0, 'active table')}`} />
          </div>
        )
      )}

      <div className="mb-3 flex flex-col gap-3 @xl:flex-row">
        <SearchBox value={search} onChange={setSearch} placeholder="Search by table number" label="Search tables" className="@xl:max-w-md" />
        <FilterSelect className="@xl:w-48" label="Area" value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">All areas</option>
          {areas.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </FilterSelect>
      </div>

      {tables && tables.length > 0 && (
        <Tabs
          idBase="tables"
          label="Table availability"
          tabs={TABS.map(([value, label]) => ({ value, label, count: counts[value] }))}
          value={availability}
          onChange={setAvailability}
          className="mb-4"
        />
      )}

      <div role="tabpanel" id={panelId('tables', availability)} aria-labelledby={tabId('tables', availability)}>
        {q.loading && (
          <Card>
            <ListSkeleton label="Loading tables" rows={4} />
          </Card>
        )}
        {!q.loading && !tables && (
          <Card>
            <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load tables" />
          </Card>
        )}
        {tables && q.error && (
          <div className="mb-3">
            <Alert tone="warning">Couldn&rsquo;t refresh the list: {q.error.message}</Alert>
          </div>
        )}

        {visible && visible.length === 0 && (
          <Card>
            <EmptyState
              icon={TableIcon}
              title={filtered ? 'No tables match' : 'No tables yet'}
              message={filtered ? 'Try a different search or clear the filters.' : 'Add your tables, then print a QR code for each so diners can order.'}
              action={
                filtered ? (
                  <Button variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : (
                  <Button icon={PlusIcon} onClick={() => setEditing('new')}>
                    Add table
                  </Button>
                )
              }
            />
          </Card>
        )}

        {visible && visible.length > 0 && (
          <>
            <ul className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4">
              {visible.map((t) => (
                <li key={t.id} className="flex flex-col rounded-2xl border border-black/[0.05] bg-white p-4">
                  <div className="flex items-start gap-3">
                    <span className={cx('grid size-11 shrink-0 place-items-center rounded-xl', t.availability === 'occupied' ? 'bg-brand-100/70 text-brand-700' : 'bg-slate-100 text-slate-400')}>
                      <TableIcon size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-lg font-semibold leading-tight text-slate-900" title={t.number}>
                        {t.number}
                      </p>
                      <p className="truncate text-sm text-slate-500" title={t.area}>
                        {t.area}
                      </p>
                    </div>
                    <AvailabilityBadge availability={t.availability} />
                  </div>
                  <p className="mt-3 flex items-center gap-1.5 text-sm text-slate-600">
                    <UsersIcon size={15} className="text-slate-400" />
                    {plural(t.capacity, 'seat')}
                  </p>
                  <div className="mt-3 flex items-center gap-1 border-t border-slate-100 pt-3">
                    {t.availability === 'occupied' && (
                      <Button variant="secondary" size="sm" icon={OrdersIcon} onClick={() => setBillFor(t)} aria-label={`Show the bill for table ${t.number}`}>
                        Bill
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" icon={QrIcon} onClick={() => setQrFor(t)} aria-label={`Show QR code for table ${t.number}`}>
                      QR
                    </Button>
                    <div className="ml-auto flex items-center">
                      <IconButton label={`Edit table ${t.number}`} icon={PencilIcon} onClick={() => setEditing(t)} />
                      <IconButton label={`Delete table ${t.number}`} icon={TrashIcon} variant="danger" onClick={() => setDeleting(t)} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <p className="px-1 pt-3 text-xs text-slate-500">
              {filtered ? `Showing ${visible.length} of ${tables.length} tables` : plural(tables.length, 'table')}
              {q.updatedAt && ` · Updated ${fmt.clock(q.updatedAt)}`}
            </p>
          </>
        )}
      </div>

      {editing && <TableFormModal table={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={q.reload} />}
      {billFor && <TableBillModal table={billFor} onClose={() => setBillFor(null)} onChanged={q.reload} />}
      {qrFor && <QrModal table={qrFor} onClose={() => setQrFor(null)} onChanged={q.reload} />}

      <ConfirmDialog
        open={Boolean(deleting)}
        title={deleting ? `Delete table ${deleting.number}?` : ''}
        message="Its QR code will stop working, so make sure any printed copy is removed. This can’t be undone."
        confirmLabel="Delete table"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          await api(`/api/admin/tables/${deleting.id}`, { method: 'DELETE' });
          toast.success(`Table ${deleting.number} deleted.`);
          setDeleting(null);
          await q.reload();
        }}
      />
    </div>
  );
}

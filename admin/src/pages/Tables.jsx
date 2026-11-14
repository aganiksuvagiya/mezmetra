import { useMemo, useState } from 'react';
import { AvailabilityBadge } from '../components/Badge.jsx';
import { Button, IconButton } from '../components/Button.jsx';
import { Card, PageHeader } from '../components/Card.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { Alert, EmptyState, ErrorState } from '../components/EmptyState.jsx';
import { SearchInput, Select } from '../components/Field.jsx';
import { OrdersIcon, PencilIcon, PlusIcon, QrIcon, RefreshIcon, TableIcon, TrashIcon, UsersIcon } from '../components/icons.jsx';
import ListSkeleton from '../components/ListSkeleton.jsx';
import { Skeleton } from '../components/Spinner.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, apiPage } from '../lib/api.js';
import { formatNumber, plural } from '../lib/format.js';
import { useDocumentTitle, useQuery } from '../lib/hooks.js';
import { useFmt } from '../lib/useFmt.js';
import QrModal from './tables/QrModal.jsx';
import TableBillModal from './tables/TableBillModal.jsx';
import TableFormModal from './tables/TableFormModal.jsx';

const GRID = 'md:grid-cols-[minmax(0,1.3fr)_7rem_minmax(0,1.3fr)_8rem_10.5rem]';

function Stat({ label, value, note }) {
  return (
    <Card className="p-4">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-xs text-slate-500">{note}</p>}
    </Card>
  );
}

export default function Tables() {
  useDocumentTitle('Tables');
  const toast = useToast();
  const fmt = useFmt();
  const [search, setSearch] = useState('');
  const [area, setArea] = useState('');
  const [availability, setAvailability] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | table
  const [qrFor, setQrFor] = useState(null);
  const [billFor, setBillFor] = useState(null);
  const [deleting, setDeleting] = useState(null);

  // The whole (small, unpaginated) list is loaded once and filtered here, so the summary strip always describes every
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
        (!availability || t.availability === availability),
    );
  }, [tables, search, area, availability]);

  const filtered = Boolean(search.trim() || area || availability);
  const clearFilters = () => {
    setSearch('');
    setArea('');
    setAvailability('');
  };

  return (
    <>
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
        <div className="mb-4 grid grid-cols-3 gap-3 sm:gap-4" role="status" aria-label="Loading summary">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : (
        tables && (
          <div className="mb-4 grid grid-cols-3 gap-3 sm:gap-4">
            <Stat label="Tables" value={formatNumber(meta.total ?? tables.length)} />
            <Stat label="Total seats" value={formatNumber(meta.total_capacity ?? 0)} />
            <Stat label="Occupancy" value={`${meta.occupancy_percent ?? 0}%`} note={`${meta.occupied_tables ?? 0} of ${plural(meta.active_tables ?? 0, 'active table')}`} />
          </div>
        )
      )}

      <Card>
        <div className="grid gap-3 border-b border-slate-100 p-3 sm:grid-cols-[minmax(0,1fr)_11rem_11rem] sm:p-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by table number" label="Search tables" />
          <Select label="Area" labelHidden value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">All areas</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
          <Select label="Availability" labelHidden value={availability} onChange={(e) => setAvailability(e.target.value)}>
            <option value="">Any availability</option>
            <option value="available">Available</option>
            <option value="occupied">Occupied</option>
            <option value="maintenance">Maintenance</option>
          </Select>
        </div>

        {q.loading && <ListSkeleton label="Loading tables" rows={4} />}
        {!q.loading && !tables && <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load tables" />}
        {tables && q.error && (
          <div className="px-4 pt-3">
            <Alert tone="warning">Couldn&rsquo;t refresh the list: {q.error.message}</Alert>
          </div>
        )}

        {visible && visible.length === 0 && (
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
        )}

        {visible && visible.length > 0 && (
          <>
            <div aria-hidden="true" className={`hidden gap-4 border-b border-slate-100 bg-slate-50 px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 md:grid ${GRID}`}>
              <span>Table</span>
              <span>Seats</span>
              <span>Area</span>
              <span>Availability</span>
              <span className="text-right">Actions</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {visible.map((t) => (
                <li key={t.id} className={`grid gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5 md:items-center ${GRID}`}>
                  <div className="flex items-center justify-between gap-3 md:block">
                    <p className="truncate font-semibold text-slate-900" title={t.number}>
                      {t.number}
                    </p>
                    <span className="md:hidden">
                      <AvailabilityBadge availability={t.availability} />
                    </span>
                  </div>
                  <p className="flex items-center gap-1.5 text-sm text-slate-600">
                    <UsersIcon size={15} className="text-slate-400" />
                    {t.capacity} <span className="md:sr-only">seats</span>
                  </p>
                  <p className="truncate text-sm text-slate-600" title={t.area}>
                    {t.area}
                  </p>
                  <span className="hidden md:block">
                    <AvailabilityBadge availability={t.availability} />
                  </span>
                  <div className="flex items-center gap-1 md:justify-end">
                    {t.availability === 'occupied' && (
                      <Button variant="secondary" size="sm" icon={OrdersIcon} onClick={() => setBillFor(t)} aria-label={`Show the bill for table ${t.number}`}>
                        Bill
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" icon={QrIcon} onClick={() => setQrFor(t)} aria-label={`Show QR code for table ${t.number}`}>
                      QR
                    </Button>
                    <IconButton label={`Edit table ${t.number}`} icon={PencilIcon} onClick={() => setEditing(t)} className="ml-auto md:ml-0" />
                    <IconButton label={`Delete table ${t.number}`} icon={TrashIcon} variant="danger" onClick={() => setDeleting(t)} />
                  </div>
                </li>
              ))}
            </ul>
            <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
              {filtered ? `Showing ${visible.length} of ${tables.length} tables` : `${plural(tables.length, 'table')}`}
              {q.updatedAt && ` · Updated ${fmt.clock(q.updatedAt)}`}
            </p>
          </>
        )}
      </Card>

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
    </>
  );
}

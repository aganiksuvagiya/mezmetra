import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ActiveBadge, Badge } from '../components/Badge.jsx';
import DietMark from '../components/DietMark.jsx';
import { Button, IconButton } from '../components/Button.jsx';
import { Card, PageHeader } from '../components/Card.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { Alert, EmptyState, ErrorState } from '../components/EmptyState.jsx';
import { SearchInput, Select, Switch } from '../components/Field.jsx';
import { ImageIcon, ListIcon, PencilIcon, PlusIcon, StarIcon, TrashIcon } from '../components/icons.jsx';
import ListSkeleton from '../components/ListSkeleton.jsx';
import Pagination from '../components/Pagination.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, apiPage, apiUrl } from '../lib/api.js';
import { useClampPage, useDebouncedValue, useDocumentTitle, useQuery } from '../lib/hooks.js';
import { useFmt } from '../lib/useFmt.js';
import ItemFormModal from './items/ItemFormModal.jsx';

const PER_PAGE = 20;
const GRID = 'md:grid-cols-[3rem_minmax(0,3fr)_minmax(0,1.4fr)_5.5rem_6rem_10.5rem]';

function Thumb({ item }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-slate-400">
      {item.photo_url && !failed ? (
        <img src={apiUrl(item.photo_url)} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <ImageIcon size={20} />
      )}
    </div>
  );
}

export default function Items() {
  useDocumentTitle('Menu items');
  const toast = useToast();
  const fmt = useFmt();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null); // null | 'new' | item
  const [deleting, setDeleting] = useState(null);
  const [busyIds, setBusyIds] = useState(() => new Set());

  const term = useDebouncedValue(search.trim());
  const cats = useQuery(() => apiPage('/api/admin/categories', { query: { per_page: 100 } }), []);
  const q = useQuery(
    () => apiPage('/api/admin/items', { query: { q: term, category_id: categoryId, status, page, per_page: PER_PAGE } }),
    [term, categoryId, status, page],
  );

  const categories = cats.data?.data ?? [];
  const rows = q.data?.data;
  const total = Number(q.data?.meta?.total ?? 0);
  useClampPage(page, total, PER_PAGE, setPage, Boolean(q.data));
  const filtered = Boolean(term || categoryId || status);
  const noCategories = Boolean(cats.data) && categories.length === 0;

  const patchItem = async (item, body, successMessage) => {
    if (busyIds.has(item.id)) return;
    setBusyIds((s) => new Set(s).add(item.id));
    try {
      await api(`/api/admin/items/${item.id}`, { method: 'PATCH', body });
      toast.success(successMessage);
      await q.reload();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  };

  const soldOutCount = Number(q.data?.meta?.sold_out ?? 0);
  const [restocking, setRestocking] = useState(false);
  const restockAll = async () => {
    if (restocking) return;
    setRestocking(true);
    try {
      const { restocked } = await api('/api/admin/items/restock', { method: 'POST' });
      toast.success(restocked === 1 ? '1 dish is back in stock.' : `${restocked} dishes are back in stock.`);
      await q.reload();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setRestocking(false);
    }
  };

  const clearFilters = () => {
    setSearch('');
    setCategoryId('');
    setStatus('');
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Menu items"
        description="The dishes diners see when they scan a table’s QR code."
        actions={
          <>
            {soldOutCount > 0 && (
              <Button variant="secondary" busy={restocking} onClick={restockAll}>
                All back in stock ({soldOutCount})
              </Button>
            )}
            <Button icon={PlusIcon} disabled={!cats.data || noCategories} onClick={() => setEditing('new')}>
              Add item
            </Button>
          </>
        }
      />

      {noCategories && (
        <Alert tone="info" className="mb-4">
          You need a category before you can add dishes.{' '}
          <Link to="/menu/categories" className="font-semibold underline">
            Create a category
          </Link>
        </Alert>
      )}
      {cats.error && !cats.data && (
        <Alert tone="warning" className="mb-4">
          Couldn&rsquo;t load categories ({cats.error.message}).{' '}
          <button type="button" onClick={cats.reload} className="font-semibold underline">
            Try again
          </button>
        </Alert>
      )}

      <Card>
        <div className="grid gap-3 border-b border-slate-100 p-3 sm:grid-cols-[minmax(0,1fr)_12rem_10rem] sm:p-4">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search dishes" label="Search dishes" pending={search.trim() !== term} />
          <Select label="Category" labelHidden value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setPage(1); }}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select label="Status" labelHidden value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="active">Available</option>
            <option value="inactive">Unavailable</option>
            <option value="sold_out">Sold out</option>
          </Select>
        </div>

        {q.loading && <ListSkeleton label="Loading menu items" />}
        {!q.loading && !rows && <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load menu items" />}

        {rows && q.error && (
          <div className="px-4 pt-3">
            <Alert tone="warning">Couldn&rsquo;t refresh the list: {q.error.message}</Alert>
          </div>
        )}

        {rows && rows.length === 0 && (
          <EmptyState
            icon={ListIcon}
            title={filtered ? 'No dishes match' : 'No dishes yet'}
            message={filtered ? 'Try a different search or clear the filters.' : 'Add your first dish to start building the menu.'}
            action={
              filtered ? (
                <Button variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button icon={PlusIcon} disabled={noCategories} onClick={() => setEditing('new')}>
                  Add item
                </Button>
              )
            }
          />
        )}

        {rows && rows.length > 0 && (
          <>
            <div aria-hidden="true" className={`hidden gap-4 border-b border-slate-100 bg-slate-50 px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 md:grid ${GRID}`}>
              <span />
              <span>Item</span>
              <span>Category</span>
              <span>Price</span>
              <span>Status</span>
              <span className="text-right">Actions</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {rows.map((item) => {
                const busy = busyIds.has(item.id);
                return (
                  <li key={item.id} className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3.5 sm:px-5 md:items-center md:gap-x-4 ${GRID}`}>
                    <Thumb key={item.photo_url ?? 'none'} item={item} />
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 font-semibold text-slate-900">
                        <DietMark diet={item.diet} />
                        <span className="truncate" title={item.name}>
                          {item.name}
                        </span>
                        {item.is_featured && (
                          <>
                            <StarIcon size={14} filled className="text-amber-500" />
                            <span className="sr-only">Featured</span>
                          </>
                        )}
                      </p>
                      {item.description && <p className="line-clamp-1 text-sm text-slate-500">{item.description}</p>}
                      <button
                        type="button"
                        aria-pressed={item.is_sold_out}
                        aria-label={`Sold out: ${item.name}`}
                        disabled={busy}
                        onClick={() =>
                          patchItem(item, { is_sold_out: !item.is_sold_out }, item.is_sold_out ? `${item.name} is back in stock.` : `${item.name} is marked sold out.`)
                        }
                        className={`mt-1.5 inline-flex h-8 items-center rounded-full px-3 text-xs font-semibold ring-1 ring-inset disabled:opacity-50 ${
                          item.is_sold_out ? 'bg-amber-100 text-amber-900 ring-amber-300 hover:bg-amber-200' : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {item.is_sold_out ? 'Sold out · tap for back in stock' : 'Mark sold out'}
                      </button>
                    </div>
                    <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600 md:contents">
                      <span className="truncate" title={item.category_name}>
                        {item.category_name}
                      </span>
                      <span className="font-semibold text-slate-900 tabular-nums">{fmt.money(item.price)}</span>
                      <span>
                        {item.is_active && item.is_sold_out ? <Badge tone="amber">Sold out</Badge> : <ActiveBadge active={item.is_active} on="Available" off="Unavailable" />}
                      </span>
                    </div>
                    <div className="col-span-2 flex items-center justify-between gap-1 md:col-span-1 md:justify-end">
                      <Switch
                        checked={item.is_active}
                        busy={busy}
                        onChange={() => patchItem(item, { is_active: !item.is_active }, `${item.name} is now ${item.is_active ? 'unavailable' : 'available'}.`)}
                        ariaLabel={`Available: ${item.name}`}
                      />
                      <div className="flex items-center">
                        <IconButton
                          label={`Feature ${item.name}`}
                          icon={StarIcon}
                          variant={item.is_featured ? 'starOn' : 'default'}
                          aria-pressed={item.is_featured}
                          disabled={busy}
                          onClick={() => patchItem(item, { is_featured: !item.is_featured }, item.is_featured ? `${item.name} is no longer featured.` : `${item.name} is now featured.`)}
                        />
                        <IconButton label={`Edit ${item.name}`} icon={PencilIcon} onClick={() => setEditing(item)} />
                        <IconButton label={`Delete ${item.name}`} icon={TrashIcon} variant="danger" onClick={() => setDeleting(item)} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <Pagination page={page} perPage={PER_PAGE} total={total} onPageChange={setPage} />
          </>
        )}
      </Card>

      {editing && (
        <ItemFormModal
          item={editing === 'new' ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={q.reload}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        title={deleting ? `Delete “${deleting.name}”?` : ''}
        message="This removes the dish from your menu. Past orders keep their details. This can’t be undone."
        confirmLabel="Delete item"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          await api(`/api/admin/items/${deleting.id}`, { method: 'DELETE' });
          toast.success(`${deleting.name} deleted.`);
          setDeleting(null);
          await q.reload();
        }}
      />
    </>
  );
}

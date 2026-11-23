import { useState } from 'react';
import { Link } from 'react-router-dom';
import DietMark from '../components/DietMark.jsx';
import { Button, IconButton } from '../components/Button.jsx';
import { Card, PageHeader } from '../components/Card.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { Alert, EmptyState, ErrorState } from '../components/EmptyState.jsx';
import FilterSelect from '../components/FilterSelect.jsx';
import { Switch } from '../components/Field.jsx';
import { ImageIcon, ListIcon, PencilIcon, PlusIcon, StarIcon, TrashIcon } from '../components/icons.jsx';
import ListSkeleton from '../components/ListSkeleton.jsx';
import Pagination from '../components/Pagination.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { panelId, tabId, Tabs } from '../components/Tabs.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, apiPage, apiUrl } from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { useClampPage, useDebouncedValue, useDocumentTitle, useQuery } from '../lib/hooks.js';
import { useFmt } from '../lib/useFmt.js';
import ItemFormModal from './items/ItemFormModal.jsx';

const PER_PAGE = 24;
const ALL = 'all';

/** The dish photo, or a quiet placeholder when it has none (or it fails to load). */
function Photo({ item }) {
  const [failed, setFailed] = useState(false);
  if (item.photo_url && !failed) {
    return <img src={apiUrl(item.photo_url)} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" />;
  }
  return (
    <span className="grid size-full place-items-center text-slate-300">
      <ImageIcon size={36} />
    </span>
  );
}

function ItemCard({ item, busy, fmt, onPatch, onEdit, onDelete }) {
  const soldOut = item.is_active && item.is_sold_out;
  return (
    <li className="flex flex-col rounded-2xl border border-black/[0.05] bg-white p-2">
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-slate-100">
        <div className={cx('size-full', !item.is_active && 'opacity-50 grayscale')}>
          <Photo key={item.photo_url ?? 'none'} item={item} />
        </div>
        {item.diet && (
          <span className="absolute left-2 top-2 inline-flex rounded-md bg-white p-0.5 shadow-sm">
            <DietMark diet={item.diet} size={14} />
          </span>
        )}
        <button
          type="button"
          aria-pressed={item.is_featured}
          aria-label={`Feature ${item.name}`}
          title={item.is_featured ? 'Featured: tap to remove' : 'Feature this dish'}
          disabled={busy}
          onClick={() => onPatch(item, { is_featured: !item.is_featured }, item.is_featured ? `${item.name} is no longer featured.` : `${item.name} is now featured.`)}
          className={cx(
            'absolute right-2 top-2 grid size-9 place-items-center rounded-full bg-white shadow-sm transition-colors disabled:opacity-50',
            item.is_featured ? 'text-amber-500' : 'text-slate-400 hover:text-slate-700',
          )}
        >
          <StarIcon size={16} filled={item.is_featured} />
        </button>
        {(soldOut || !item.is_active) && (
          <span className={cx('absolute inset-x-0 bottom-0 py-1 text-center text-xs font-semibold text-white', soldOut ? 'bg-amber-600/90' : 'bg-slate-800/75')}>
            {soldOut ? 'Sold out' : 'Unavailable'}
          </span>
        )}
      </div>

      <div className="flex-1 px-1.5 pt-2.5">
        <p className="truncate text-sm font-semibold text-slate-900" title={item.name}>
          {item.name}
        </p>
        <p className="truncate text-xs text-slate-500" title={item.category_name}>
          {item.category_name}
        </p>
        <p className="mt-1 text-base font-semibold text-slate-900 tabular-nums">{fmt.money(item.price)}</p>
        <button
          type="button"
          aria-pressed={item.is_sold_out}
          aria-label={`Sold out: ${item.name}`}
          disabled={busy}
          onClick={() => onPatch(item, { is_sold_out: !item.is_sold_out }, item.is_sold_out ? `${item.name} is back in stock.` : `${item.name} is marked sold out.`)}
          className={cx(
            'mt-2 inline-flex h-8 items-center rounded-full px-3 text-xs font-semibold ring-1 ring-inset disabled:opacity-50',
            item.is_sold_out ? 'bg-amber-100 text-amber-900 ring-amber-300 hover:bg-amber-200' : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50',
          )}
        >
          {item.is_sold_out ? 'Back in stock' : 'Mark sold out'}
        </button>
      </div>

      <div className="mt-2 flex items-center justify-between gap-1 border-t border-slate-100 px-1 pt-2">
        <Switch
          checked={item.is_active}
          busy={busy}
          onChange={() => onPatch(item, { is_active: !item.is_active }, `${item.name} is now ${item.is_active ? 'unavailable' : 'available'}.`)}
          ariaLabel={`Available: ${item.name}`}
        />
        <div className="flex items-center">
          <IconButton label={`Edit ${item.name}`} icon={PencilIcon} onClick={() => onEdit(item)} />
          <IconButton label={`Delete ${item.name}`} icon={TrashIcon} variant="danger" onClick={() => onDelete(item)} />
        </div>
      </div>
    </li>
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
      cats.reload();
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

  // One tab per category, with how many dishes it holds; the first tab is every dish.
  const tabs = [
    { value: ALL, label: 'All', count: cats.data ? categories.reduce((sum, c) => sum + Number(c.item_count ?? 0), 0) : undefined },
    ...categories.map((c) => ({ value: String(c.id), label: c.name, count: c.item_count })),
  ];
  const tab = categoryId === '' ? ALL : String(categoryId);

  return (
    <div className="@container">
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

      <div className="mb-3 flex flex-col gap-3 @xl:flex-row">
        <SearchBox
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search dishes"
          className="@xl:max-w-md"
        />
        <FilterSelect
          className="@xl:w-48"
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="active">Available</option>
          <option value="inactive">Unavailable</option>
          <option value="sold_out">Sold out</option>
        </FilterSelect>
      </div>

      {categories.length > 0 && (
        <Tabs
          idBase="items"
          label="Menu category"
          tabs={tabs}
          value={tab}
          onChange={(value) => {
            setCategoryId(value === ALL ? '' : value);
            setPage(1);
          }}
          className="mb-4"
        />
      )}

      <div role="tabpanel" id={panelId('items', tab)} aria-labelledby={tabId('items', tab)}>
        {q.loading && (
          <Card>
            <ListSkeleton label="Loading menu items" />
          </Card>
        )}
        {!q.loading && !rows && (
          <Card>
            <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load menu items" />
          </Card>
        )}

        {rows && q.error && (
          <div className="mb-3">
            <Alert tone="warning">Couldn&rsquo;t refresh the list: {q.error.message}</Alert>
          </div>
        )}

        {rows && rows.length === 0 && (
          <Card>
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
          </Card>
        )}

        {rows && rows.length > 0 && (
          <>
            <ul className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @4xl:grid-cols-4 @6xl:grid-cols-5">
              {rows.map((item) => (
                <ItemCard key={item.id} item={item} busy={busyIds.has(item.id)} fmt={fmt} onPatch={patchItem} onEdit={setEditing} onDelete={setDeleting} />
              ))}
            </ul>
            <Pagination page={page} perPage={PER_PAGE} total={total} onPageChange={setPage} className="mt-2 border-t-0 px-1" />
          </>
        )}
      </div>

      {editing && (
        <ItemFormModal
          item={editing === 'new' ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            q.reload();
            cats.reload();
          }}
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
          cats.reload();
        }}
      />
    </div>
  );
}

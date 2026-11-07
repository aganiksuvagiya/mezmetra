import { useState } from 'react';
import { ActiveBadge } from '../components/Badge.jsx';
import { Button, IconButton } from '../components/Button.jsx';
import { Card, PageHeader } from '../components/Card.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { Alert, EmptyState, ErrorState } from '../components/EmptyState.jsx';
import { focusFirstInvalid, Input, SearchInput, Select, SwitchField, Switch, Textarea } from '../components/Field.jsx';
import { PencilIcon, PlusIcon, TagIcon, TrashIcon } from '../components/icons.jsx';
import ListSkeleton from '../components/ListSkeleton.jsx';
import Modal from '../components/Modal.jsx';
import Pagination from '../components/Pagination.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, apiPage, splitFieldErrors } from '../lib/api.js';
import { changedFields } from '../lib/forms.js';
import { plural } from '../lib/format.js';
import { useAction, useClampPage, useDebouncedValue, useDocumentTitle, useQuery } from '../lib/hooks.js';

const PER_PAGE = 20;
const GRID = 'md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_6rem_5rem_9.5rem]';

function CategoryFormModal({ category, onClose, onSaved }) {
  const isEdit = Boolean(category);
  const toast = useToast();
  const [run, busy] = useAction();
  const [values, setValues] = useState({
    name: category?.name ?? '',
    description: category?.description ?? '',
    sort_order: String(category?.sort_order ?? 0),
    is_active: category?.is_active ?? true,
  });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);

  const set = (field) => (e) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    const name = values.name.trim();
    if (!name) next.name = 'Enter a category name.';
    else if (name.length > 80) next.name = 'Keep the name under 80 characters.';
    if (values.description.trim().length > 500) next.description = 'Keep the description under 500 characters.';
    if (!/^\d+$/.test(values.sort_order.trim() || '0') || Number(values.sort_order || 0) > 100000) next.sort_order = 'Use a whole number from 0 to 100000.';
    return next;
  };

  const toPayload = (v) => ({
    name: v.name.trim(),
    description: v.description.trim(),
    sort_order: Number(v.sort_order.trim() || 0),
    is_active: v.is_active,
  });

  const submit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const found = validate();
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) {
      focusFirstInvalid(form);
      return;
    }
    const payload = toPayload(values);
    const body = isEdit ? changedFields(toPayload({ ...category, sort_order: String(category.sort_order) }), payload) : payload;
    if (isEdit && Object.keys(body).length === 0) {
      toast.info('No changes to save.');
      onClose();
      return;
    }
    run(async () => {
      try {
        if (isEdit) await api(`/api/admin/categories/${category.id}`, { method: 'PATCH', body });
        else await api('/api/admin/categories', { method: 'POST', body });
        toast.success(isEdit ? 'Category updated.' : 'Category added.');
        await onSaved();
        onClose();
      } catch (error) {
        const { fields, formError: message } = splitFieldErrors(error, ['name', 'description', 'sort_order']);
        setErrors(fields);
        setFormError(message);
        if (Object.keys(fields).length) focusFirstInvalid(form);
      }
    });
  };

  return (
    <Modal
      title={isEdit ? 'Edit category' : 'Add category'}
      onClose={onClose}
      dismissible={!busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add category'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {formError && <Alert>{formError}</Alert>}
        <Input label="Name" value={values.name} onChange={set('name')} error={errors.name} required maxLength={80} placeholder="e.g. Pizza" />
        <Textarea label="Description" value={values.description} onChange={set('description')} error={errors.description} hint="Optional. Shown to diners under the category name." maxLength={500} />
        <Input
          label="Display order"
          inputMode="numeric"
          value={values.sort_order}
          onChange={set('sort_order')}
          error={errors.sort_order}
          hint="Lower numbers appear first in the menu."
          wrapperClassName="max-w-40"
        />
        <SwitchField
          label="Active"
          description="Inactive categories (and their dishes) are hidden from diners."
          checked={values.is_active}
          onChange={(checked) => setValues((v) => ({ ...v, is_active: checked }))}
        />
      </div>
    </Modal>
  );
}

export default function Categories() {
  useDocumentTitle('Categories');
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null); // null | 'new' | category
  const [deleting, setDeleting] = useState(null);
  const [togglingIds, setTogglingIds] = useState(() => new Set());

  const term = useDebouncedValue(search.trim());
  const q = useQuery(
    () => apiPage('/api/admin/categories', { query: { q: term, status, page, per_page: PER_PAGE } }),
    [term, status, page],
  );
  const rows = q.data?.data;
  const total = Number(q.data?.meta?.total ?? 0);
  useClampPage(page, total, PER_PAGE, setPage, Boolean(q.data));

  const filtered = Boolean(term || status);

  const toggleActive = async (category) => {
    if (togglingIds.has(category.id)) return;
    setTogglingIds((s) => new Set(s).add(category.id));
    try {
      await api(`/api/admin/categories/${category.id}`, { method: 'PATCH', body: { is_active: !category.is_active } });
      toast.success(`${category.name} is now ${category.is_active ? 'inactive' : 'active'}.`);
      await q.reload();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setTogglingIds((s) => {
        const next = new Set(s);
        next.delete(category.id);
        return next;
      });
    }
  };

  return (
    <>
      <PageHeader
        title="Categories"
        description="Group your dishes so diners can find them quickly."
        actions={
          <Button icon={PlusIcon} onClick={() => setEditing('new')}>
            Add category
          </Button>
        }
      />

      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-3 sm:flex-row sm:p-4">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search categories" label="Search categories" pending={search.trim() !== term} className="sm:max-w-xs sm:flex-1" />
          <Select label="Status" labelHidden value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} wrapperClassName="sm:w-44">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
        </div>

        {q.loading && <ListSkeleton label="Loading categories" />}
        {!q.loading && !rows && <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load categories" />}

        {rows && q.error && (
          <div className="px-4 pt-3">
            <Alert tone="warning">Couldn&rsquo;t refresh the list: {q.error.message}</Alert>
          </div>
        )}

        {rows && rows.length === 0 && (
          <EmptyState
            icon={TagIcon}
            title={filtered ? 'No categories match' : 'No categories yet'}
            message={filtered ? 'Try a different search or status filter.' : 'Create your first category, like Starters or Desserts, then add dishes to it.'}
            action={
              filtered ? (
                <Button variant="secondary" onClick={() => { setSearch(''); setStatus(''); setPage(1); }}>
                  Clear filters
                </Button>
              ) : (
                <Button icon={PlusIcon} onClick={() => setEditing('new')}>
                  Add category
                </Button>
              )
            }
          />
        )}

        {rows && rows.length > 0 && (
          <>
            <div aria-hidden="true" className={`hidden gap-4 border-b border-slate-100 bg-slate-50 px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 md:grid ${GRID}`}>
              <span>Name</span>
              <span>Description</span>
              <span>Status</span>
              <span>Items</span>
              <span className="text-right">Actions</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {rows.map((c) => (
                <li key={c.id} className={`grid gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5 md:items-center ${GRID}`}>
                  <div className="flex min-w-0 items-center justify-between gap-3 md:block">
                    <p className="truncate font-semibold text-slate-900" title={c.name}>
                      {c.name}
                    </p>
                    <span className="md:hidden">
                      <ActiveBadge active={c.is_active} />
                    </span>
                  </div>
                  <p className="line-clamp-2 min-w-0 text-sm text-slate-500">{c.description || <span className="text-slate-400">No description</span>}</p>
                  <span className="hidden md:block">
                    <ActiveBadge active={c.is_active} />
                  </span>
                  <p className="text-sm text-slate-600">{plural(c.item_count, 'item')}</p>
                  <div className="flex items-center justify-between gap-1 md:justify-end">
                    <Switch
                      checked={c.is_active}
                      onChange={() => toggleActive(c)}
                      busy={togglingIds.has(c.id)}
                      ariaLabel={`Active: ${c.name}`}
                      className="mr-1"
                    />
                    <div className="flex items-center">
                      <IconButton label={`Edit ${c.name}`} icon={PencilIcon} onClick={() => setEditing(c)} />
                      <IconButton label={`Delete ${c.name}`} icon={TrashIcon} variant="danger" onClick={() => setDeleting(c)} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <Pagination page={page} perPage={PER_PAGE} total={total} onPageChange={setPage} />
          </>
        )}
      </Card>

      {editing && <CategoryFormModal category={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={q.reload} />}

      <ConfirmDialog
        open={Boolean(deleting)}
        title={deleting ? `Delete “${deleting.name}”?` : ''}
        message={
          <>
            <p>This permanently removes the category. A category that still has dishes can&rsquo;t be deleted &mdash; move or delete its dishes first.</p>
            {deleting?.item_count > 0 && <p className="mt-2 font-medium text-amber-800">It currently has {plural(deleting.item_count, 'item')}.</p>}
          </>
        }
        confirmLabel="Delete category"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          await api(`/api/admin/categories/${deleting.id}`, { method: 'DELETE' });
          toast.success(`${deleting.name} deleted.`);
          setDeleting(null);
          await q.reload();
        }}
      />
    </>
  );
}

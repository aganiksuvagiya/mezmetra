import { useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button.jsx';
import { Alert } from '../../components/EmptyState.jsx';
import { focusFirstInvalid, Input, Select, SwitchField, Textarea } from '../../components/Field.jsx';
import Modal from '../../components/Modal.jsx';
import OptionGroupsEditor from '../../components/OptionGroupsEditor.jsx';
import PhotoField from '../../components/PhotoField.jsx';
import { useToast } from '../../components/Toast.jsx';
import { api, splitFieldErrors } from '../../lib/api.js';
import { changedFields, isMoneyString } from '../../lib/forms.js';
import { useAction } from '../../lib/hooks.js';
import { DIET_LABELS } from '../../components/DietMark.jsx';
import { groupsFromApi, groupsToApi, validateGroups } from '../../lib/optionGroups.js';

function initialValues(item, categories) {
  return {
    name: item?.name ?? '',
    category_id: String(item?.category_id ?? categories[0]?.id ?? ''),
    price: item ? String(item.price) : '',
    description: item?.description ?? '',
    is_active: item?.is_active ?? true,
    is_featured: item?.is_featured ?? false,
    diet: item?.diet ?? '',
  };
}

const toPayload = (v, groups) => ({
  category_id: Number(v.category_id),
  name: v.name.trim(),
  description: v.description.trim(),
  price: Number(v.price),
  is_active: v.is_active,
  is_featured: v.is_featured,
  diet: v.diet || null,
  option_groups: groupsToApi(groups),
});

/**
 * Add/edit a menu item. The item is saved first (POST, or PATCH with only the changed fields); only then is the photo
 * uploaded/removed. If the photo step fails after a successful save, the dialog stays open in "edit" mode so retrying
 * never creates a duplicate item.
 */
export default function ItemFormModal({ item, categories, onClose, onSaved }) {
  const toast = useToast();
  const [run, busy] = useAction();

  const categoryOptions = useMemo(
    () => (item && !categories.some((c) => c.id === item.category_id) ? [{ id: item.category_id, name: item.category_name }, ...categories] : categories),
    [item, categories],
  );

  const [values, setValues] = useState(() => initialValues(item, categoryOptions));
  const [groups, setGroups] = useState(() => groupsFromApi(item?.option_groups));
  const [photo, setPhoto] = useState({ blob: null, removed: false });
  const [errors, setErrors] = useState({});
  const [groupErrors, setGroupErrors] = useState(null);
  const [formError, setFormError] = useState(null);
  const [savedId, setSavedId] = useState(item?.id ?? null);

  // What the server currently has, so a retry sends only what is still different.
  const server = useRef({
    id: item?.id ?? null,
    payload: item ? toPayload(initialValues(item, categoryOptions), groupsFromApi(item.option_groups)) : null,
    hasPhoto: Boolean(item?.photo_url),
  });

  const set = (field) => (e) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    const name = values.name.trim();
    if (!name) next.name = 'Enter an item name.';
    else if (name.length > 120) next.name = 'Keep the name under 120 characters.';
    if (!values.category_id) next.category_id = 'Choose a category.';
    const price = values.price.trim();
    if (!price) next.price = 'Enter a price.';
    else if (!isMoneyString(price) || Number(price) > 1_000_000) next.price = 'Use a price like 199 or 199.50.';
    if (values.description.trim().length > 1000) next.description = 'Keep the description under 1000 characters.';
    return next;
  };

  const submit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const found = validate();
    const groupFound = validateGroups(groups);
    setErrors(found);
    setGroupErrors(groupFound);
    setFormError(null);
    if (Object.keys(found).length || groupFound) {
      if (!Object.keys(found).length) setFormError('Fix the highlighted option fields to continue.');
      focusFirstInvalid(form);
      return;
    }

    const payload = toPayload(values, groups);

    run(async () => {
      const state = server.current;
      let latest = null;

      // 1) the item itself
      try {
        if (!state.id) {
          latest = await api('/api/admin/items', { method: 'POST', body: payload });
          state.id = latest.id;
          state.payload = payload;
          state.hasPhoto = Boolean(latest.photo_url);
          setSavedId(latest.id);
        } else {
          const body = changedFields(state.payload, payload);
          if (Object.keys(body).length > 0) {
            latest = await api(`/api/admin/items/${state.id}`, { method: 'PATCH', body });
            state.payload = payload;
          }
        }
      } catch (error) {
        const { fields, formError: message } = splitFieldErrors(error, ['name', 'category_id', 'description', 'price']);
        setErrors(fields);
        setFormError(message);
        if (Object.keys(fields).length) focusFirstInvalid(form);
        return;
      }

      // 2) the photo
      try {
        if (photo.blob) {
          latest = await api(`/api/admin/items/${state.id}/photo`, { method: 'PUT', body: photo.blob });
          state.hasPhoto = true;
          setPhoto({ blob: null, removed: false });
        } else if (photo.removed && state.hasPhoto) {
          latest = await api(`/api/admin/items/${state.id}/photo`, { method: 'DELETE' });
          state.hasPhoto = false;
        }
      } catch (error) {
        await onSaved(); // the item itself is saved - show it in the list behind this dialog
        setFormError(`The item was saved, but its photo wasn't updated: ${error.message} You can try again.`);
        return;
      }

      if (!latest) {
        toast.info('No changes to save.');
        onClose();
        return;
      }
      toast.success(item || savedId ? 'Item updated.' : 'Item added.');
      await onSaved();
      onClose();
    });
  };

  const editing = Boolean(savedId);

  return (
    <Modal
      title={editing ? 'Edit item' : 'Add item'}
      size="xl"
      onClose={onClose}
      dismissible={!busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add item'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {formError && <Alert>{formError}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Name" value={values.name} onChange={set('name')} error={errors.name} required maxLength={120} placeholder="e.g. Margherita Pizza" wrapperClassName="sm:col-span-2" />
          <Select label="Category" value={values.category_id} onChange={set('category_id')} error={errors.category_id} required>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.is_active === false ? ' (inactive)' : ''}
              </option>
            ))}
          </Select>
          <Input label="Price" value={values.price} onChange={set('price')} error={errors.price} required inputMode="decimal" prefix="₹" placeholder="0" />
          <Select label="Food type" value={values.diet} onChange={set('diet')} hint="Shown to diners as the green / red mark. Leave it unmarked if you are not sure.">
            <option value="">Not marked</option>
            {Object.entries(DIET_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Textarea label="Description" value={values.description} onChange={set('description')} error={errors.description} hint="Optional. Ingredients, spice level, serving size…" maxLength={1000} wrapperClassName="sm:col-span-2" />
        </div>

        <div className="grid gap-4 rounded-xl border border-slate-200 p-4 sm:grid-cols-2">
          <SwitchField label="Available" description="Turn off to hide this dish from diners." checked={values.is_active} onChange={(checked) => setValues((v) => ({ ...v, is_active: checked }))} />
          <SwitchField label="Featured" description="Featured dishes are shown first." checked={values.is_featured} onChange={(checked) => setValues((v) => ({ ...v, is_featured: checked }))} />
        </div>

        <section aria-labelledby="item-photo">
          <h3 id="item-photo" className="mb-3 text-sm font-semibold text-slate-900">
            Photo
          </h3>
          <PhotoField existingUrl={item?.photo_url ?? null} photo={photo} onChange={setPhoto} disabled={busy} />
        </section>

        <section aria-labelledby="item-options">
          <h3 id="item-options" className="text-sm font-semibold text-slate-900">
            Options &amp; add-ons
          </h3>
          <p className="mb-3 mt-0.5 text-xs text-slate-500">Let diners choose a size, toppings and so on. Each option can add to the price.</p>
          <OptionGroupsEditor groups={groups} onChange={setGroups} errors={groupErrors} disabled={busy} />
        </section>
      </div>
    </Modal>
  );
}

import { useId, useState } from 'react';
import { Button } from '../../components/Button.jsx';
import { Alert } from '../../components/EmptyState.jsx';
import { focusFirstInvalid, Input, SwitchField } from '../../components/Field.jsx';
import Modal from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { api, splitFieldErrors } from '../../lib/api.js';
import { changedFields } from '../../lib/forms.js';
import { useAction, useQuery } from '../../lib/hooks.js';

const toPayload = (v) => ({
  number: v.number.trim(),
  capacity: Number(v.capacity.trim()),
  area: v.area.trim(),
  is_active: v.is_active,
});

/** Add/edit a table. Editing sends only the fields that changed (so changing seats never touches the active flag). */
export default function TableFormModal({ table, onClose, onSaved }) {
  const isEdit = Boolean(table);
  const toast = useToast();
  const [run, busy] = useAction();
  const listId = useId();
  const areas = useQuery(() => api('/api/admin/tables/areas'), []);

  const [values, setValues] = useState({
    number: table?.number ?? '',
    capacity: String(table?.capacity ?? 4),
    area: table?.area ?? 'Indoor',
    is_active: table?.is_active ?? true,
  });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);

  const set = (field) => (e) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    const number = values.number.trim();
    if (!number) next.number = 'Enter a table number or name.';
    else if (number.length > 30) next.number = 'Keep it under 30 characters.';
    const seats = values.capacity.trim();
    if (!/^\d+$/.test(seats) || Number(seats) < 1 || Number(seats) > 100) next.capacity = 'Enter a whole number from 1 to 100.';
    const area = values.area.trim();
    if (!area) next.area = 'Enter an area, like Indoor or Terrace.';
    else if (area.length > 40) next.area = 'Keep it under 40 characters.';
    return next;
  };

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
    const body = isEdit ? changedFields(toPayload({ ...table, capacity: String(table.capacity) }), payload) : payload;
    if (isEdit && Object.keys(body).length === 0) {
      toast.info('No changes to save.');
      onClose();
      return;
    }
    run(async () => {
      try {
        if (isEdit) await api(`/api/admin/tables/${table.id}`, { method: 'PATCH', body });
        else await api('/api/admin/tables', { method: 'POST', body });
        toast.success(isEdit ? 'Table updated.' : 'Table added.');
        await onSaved();
        onClose();
      } catch (error) {
        const { fields, formError: message } = splitFieldErrors(error, ['number', 'capacity', 'area']);
        // The unique-number rule comes back as a 409 without field details.
        if (error.code === 'DUPLICATE') {
          setErrors({ number: 'A table with this number already exists.' });
          focusFirstInvalid(form);
          return;
        }
        setErrors(fields);
        setFormError(message);
        if (Object.keys(fields).length) focusFirstInvalid(form);
      }
    });
  };

  return (
    <Modal
      title={isEdit ? `Edit table ${table.number}` : 'Add table'}
      onClose={onClose}
      dismissible={!busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add table'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {formError && <Alert>{formError}</Alert>}
        <Input label="Table number" value={values.number} onChange={set('number')} error={errors.number} required maxLength={30} placeholder="e.g. T-07" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Seats" value={values.capacity} onChange={set('capacity')} error={errors.capacity} required inputMode="numeric" />
          <div>
            <Input label="Area" list={listId} value={values.area} onChange={set('area')} error={errors.area} required maxLength={40} autoComplete="off" />
            <datalist id={listId}>
              {(areas.data ?? []).map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
        </div>
        <SwitchField
          label="Active"
          description="Turn off for maintenance. An inactive table's QR code stops taking orders."
          checked={values.is_active}
          onChange={(checked) => setValues((v) => ({ ...v, is_active: checked }))}
        />
      </div>
    </Modal>
  );
}

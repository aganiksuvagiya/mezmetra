import { useState } from 'react';
import { Button } from './Button.jsx';
import { Card, CardHeader } from './Card.jsx';
import { Alert } from './EmptyState.jsx';
import { focusFirstInvalid, Input, Textarea } from './Field.jsx';
import { useToast } from './Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api, splitFieldErrors } from '../lib/api.js';
import { changedFields } from '../lib/forms.js';
import { useAction } from '../lib/hooks.js';

const FIELDS = ['bill_name', 'bill_address', 'gstin', 'fssai', 'bill_contact'];
const read = (source) => Object.fromEntries(FIELDS.map((key) => [key, source[key] ?? '']));
const toPayload = (v) => ({ ...Object.fromEntries(FIELDS.map((key) => [key, v[key].trim()])), gstin: v.gstin.trim().toUpperCase() });

/** What gets printed on the restaurant's bills besides its name. Everything here is optional. */
export default function BillDetailsCard() {
  const { vendor, updateVendor } = useAuth();
  const toast = useToast();
  const [run, busy] = useAction();
  const [values, setValues] = useState(() => read(vendor));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);

  const set = (field) => (e) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };
  const changes = changedFields(toPayload(read(vendor)), toPayload(values));
  const dirty = Object.keys(changes).length > 0;

  const submit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const next = {};
    const { gstin, fssai } = toPayload(values);
    if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}$/.test(gstin)) next.gstin = 'A GSTIN has 15 characters, like 24ABCDE1234F1Z5.';
    if (fssai && !/^\d{14}$/.test(fssai)) next.fssai = 'An FSSAI licence number has 14 digits.';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) {
      focusFirstInvalid(form);
      return;
    }
    run(async () => {
      try {
        const saved = await api('/api/admin/vendor', { method: 'PATCH', body: changes });
        updateVendor(saved);
        setValues(read(saved));
        toast.success('Bill details saved.');
      } catch (error) {
        const { fields, formError: message } = splitFieldErrors(error, FIELDS);
        setErrors(fields);
        setFormError(message);
        if (Object.keys(fields).length) focusFirstInvalid(form);
      }
    });
  };

  return (
    <Card as="section" aria-labelledby="bill-details">
      <CardHeader id="bill-details" title="Bill details" description="Printed on your bills. Leave empty what you don’t need." />
      <form onSubmit={submit} noValidate className="space-y-4 p-4 sm:p-5">
        {formError && <Alert>{formError}</Alert>}
        <Input label="Name on the bill" value={values.bill_name} onChange={set('bill_name')} error={errors.bill_name} maxLength={120} placeholder={vendor.name} hint="Your registered business name, if it differs from the restaurant name." />
        <Textarea label="Address" rows={2} value={values.bill_address} onChange={set('bill_address')} error={errors.bill_address} maxLength={200} />
        <Input label="GSTIN" value={values.gstin} onChange={set('gstin')} error={errors.gstin} maxLength={15} autoCapitalize="characters" hint="Only if you are registered for GST: the bill is then headed “Tax Invoice” and the tax is shown as CGST and SGST." />
        <Input label="FSSAI licence number" value={values.fssai} onChange={set('fssai')} error={errors.fssai} maxLength={14} inputMode="numeric" />
        <Input label="Contact for questions" value={values.bill_contact} onChange={set('bill_contact')} error={errors.bill_contact} maxLength={120} hint="A phone number or email, printed at the foot of the bill." />
        <div className="flex justify-end pt-1">
          <Button type="submit" busy={busy} disabled={!dirty}>
            {busy ? 'Saving…' : 'Save bill details'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

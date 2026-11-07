import { useId, useMemo, useState } from 'react';
import { Button } from '../components/Button.jsx';
import { Card, CardHeader, PageHeader } from '../components/Card.jsx';
import { Alert } from '../components/EmptyState.jsx';
import { focusFirstInvalid, Input } from '../components/Field.jsx';
import { LogoutIcon } from '../components/icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api, splitFieldErrors } from '../lib/api.js';
import { changedFields } from '../lib/forms.js';
import { formatDateTime } from '../lib/format.js';
import { useAction, useDocumentTitle } from '../lib/hooks.js';

function timeZoneList(current) {
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  // Some browsers omit UTC or list India as "Asia/Calcutta"; always offer the usual names and the saved one.
  return [...new Set([...zones, 'Asia/Kolkata', 'UTC', current].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function isValidZone(zone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const toPayload = (v) => ({ name: v.name.trim(), tax_percent: Number(v.tax_percent.trim()), timezone: v.timezone.trim() });

export default function Settings() {
  useDocumentTitle('Settings');
  const { vendor, updateVendor, logout } = useAuth();
  const toast = useToast();
  const [run, busy] = useAction();
  const listId = useId();

  const zones = useMemo(() => timeZoneList(vendor.timezone), [vendor.timezone]);
  const [values, setValues] = useState({ name: vendor.name, tax_percent: String(vendor.tax_percent), timezone: vendor.timezone });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);

  const set = (field) => (e) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const baseline = toPayload({ name: vendor.name, tax_percent: String(vendor.tax_percent), timezone: vendor.timezone });
  const dirty = Object.keys(changedFields(baseline, toPayload(values))).length > 0;
  const zoneOk = isValidZone(values.timezone.trim());
  const clock = zoneOk && values.timezone.trim() ? formatDateTime(new Date(), values.timezone.trim()) : null;

  const validate = () => {
    const next = {};
    const name = values.name.trim();
    if (name.length < 2) next.name = 'Enter your restaurant name (at least 2 characters).';
    else if (name.length > 100) next.name = 'Keep the name under 100 characters.';
    const tax = values.tax_percent.trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(tax) || Number(tax) > 100) next.tax_percent = 'Enter a percentage from 0 to 100, like 5 or 12.5.';
    if (!values.timezone.trim()) next.timezone = 'Choose a time zone.';
    else if (!zoneOk) next.timezone = 'That time zone isn’t recognised. Pick one from the list, like Asia/Kolkata.';
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
    const body = changedFields(baseline, toPayload(values));
    if (Object.keys(body).length === 0) {
      toast.info('No changes to save.');
      return;
    }
    run(async () => {
      try {
        const saved = await api('/api/admin/vendor', { method: 'PATCH', body });
        updateVendor(saved);
        setValues({ name: saved.name, tax_percent: String(saved.tax_percent), timezone: saved.timezone });
        toast.success('Settings saved.');
      } catch (error) {
        const { fields, formError: message } = splitFieldErrors(error, ['name', 'tax_percent', 'timezone']);
        setErrors(fields);
        setFormError(message);
        if (Object.keys(fields).length) focusFirstInvalid(form);
      }
    });
  };

  return (
    <>
      <PageHeader title="Settings" description="Your restaurant’s details." />

      <div className="max-w-2xl space-y-4 sm:space-y-6">
        <Card as="section" aria-labelledby="restaurant">
          <CardHeader id="restaurant" title="Restaurant" />
          <form onSubmit={submit} noValidate className="space-y-4 p-4 sm:p-5">
            {formError && <Alert>{formError}</Alert>}
            <Input label="Restaurant name" value={values.name} onChange={set('name')} error={errors.name} required maxLength={100} autoComplete="organization" />
            <Input
              label="Tax percent"
              value={values.tax_percent}
              onChange={set('tax_percent')}
              error={errors.tax_percent}
              inputMode="decimal"
              required
              suffix={<span className="pr-2 text-sm text-slate-500">%</span>}
              hint="Added to the bill of new orders. Orders already placed keep the tax they were created with."
              wrapperClassName="max-w-48"
            />
            <div>
              <Input
                label="Time zone"
                list={listId}
                value={values.timezone}
                onChange={set('timezone')}
                error={errors.timezone}
                required
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                hint={clock ? `It is ${clock} there now. Dates and times across the admin use this zone.` : 'Start typing, for example Asia/Kolkata.'}
              />
              <datalist id={listId}>
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </div>
            <p className="text-sm text-slate-500">
              Currency: <strong className="font-semibold text-slate-700">Indian rupee (₹)</strong>
            </p>
            <div className="flex justify-end pt-1">
              <Button type="submit" busy={busy} disabled={!dirty}>
                {busy ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </form>
        </Card>

        <Card as="section" aria-labelledby="account">
          <CardHeader id="account" title="Account" description="You are signed in as" />
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
            <p className="min-w-0 break-all font-medium text-slate-900">{vendor.email}</p>
            <Button variant="secondary" icon={LogoutIcon} onClick={logout}>
              Sign out
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}

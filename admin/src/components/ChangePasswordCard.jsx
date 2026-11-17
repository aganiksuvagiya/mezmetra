import { useState } from 'react';
import { Button } from './Button.jsx';
import { Card, CardHeader } from './Card.jsx';
import { Alert } from './EmptyState.jsx';
import { focusFirstInvalid, PasswordInput } from './Field.jsx';
import { useToast } from './Toast.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api, splitFieldErrors } from '../lib/api.js';
import { auth } from '../lib/auth.js';
import { cx } from '../lib/cx.js';

const MIN = 8;

/** A rough, honest strength check: length first, then variety, and nothing that spells out the email or a lazy pattern. */
export function passwordStrength(password, email = '') {
  if (password.length < MIN) return null;
  const local = String(email).split('@')[0].toLowerCase();
  const lower = password.toLowerCase();
  const lazy = (local.length >= 3 && lower.includes(local)) || /(password|qwerty|12345|abcde|0000|1111)/.test(lower);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const score = (password.length >= 12 ? 1 : 0) + (password.length >= 16 ? 1 : 0) + (classes >= 3 ? 1 : 0) - (lazy ? 1 : 0);
  if (score >= 3) return { label: 'Strong', tone: 'text-emerald-700', note: '' };
  if (score === 2) return { label: 'Okay', tone: 'text-amber-700', note: 'A little longer would make it safer.' };
  return {
    label: 'Weak',
    tone: 'text-red-700',
    note: lazy ? 'Avoid your email, names and simple patterns like 123.' : 'Use 12 or more characters, with letters, numbers and symbols.',
  };
}

/** Change the password of the signed-in restaurant. Other devices are signed out; this one keeps going with a fresh session. */
export default function ChangePasswordCard() {
  const { vendor, updateVendor } = useAuth();
  const toast = useToast();
  const [values, setValues] = useState({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    setErrors((er) => ({ ...er, [key]: undefined }));
  };
  const strength = passwordStrength(values.next, vendor.email);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const found = {};
    if (!values.current) found.current = 'Enter your current password';
    if (values.next.length < MIN) found.next = `Use at least ${MIN} characters`;
    else if (values.next === values.current) found.next = 'Choose a password that is different from your current one';
    if (values.confirm !== values.next) found.confirm = 'The two new passwords do not match';
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) {
      focusFirstInvalid(form);
      return;
    }

    setBusy(true);
    try {
      const { token, vendor: fresh } = await api('/api/auth/change-password', {
        method: 'POST',
        body: { current_password: values.current, new_password: values.next },
      });
      auth.setToken(token); // the change signed out every older session, including this one's token
      updateVendor(fresh);
      setValues({ current: '', next: '', confirm: '' });
      toast.success('Password changed. Your other devices were signed out.');
    } catch (error) {
      if (error.code === 'WRONG_PASSWORD') setErrors({ current: error.message });
      else if (error.code === 'SAME_PASSWORD') setErrors({ next: error.message });
      else {
        const { fields, formError: message } = splitFieldErrors(error, ['current_password', 'new_password']);
        setErrors({ current: fields.current_password, next: fields.new_password });
        setFormError(message);
      }
      requestAnimationFrame(() => focusFirstInvalid(form));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="section" aria-labelledby="password">
      <CardHeader id="password" title="Password" description="Change the password you sign in with. Your other devices will be signed out." />
      <form onSubmit={submit} noValidate className="space-y-4 p-4 sm:p-5">
        {formError && <Alert>{formError}</Alert>}
        {/* Lets a password manager file the new password under the right account. */}
        <input type="text" name="username" autoComplete="username" value={vendor.email} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
        <PasswordInput label="Current password" value={values.current} onChange={set('current')} error={errors.current} required autoComplete="current-password" maxLength={200} />
        <div>
          <PasswordInput
            label="New password"
            value={values.next}
            onChange={set('next')}
            error={errors.next}
            required
            autoComplete="new-password"
            maxLength={200}
            hint={`At least ${MIN} characters. 12 or more with letters, numbers and symbols is much safer.`}
          />
          <p aria-live="polite" className="mt-1.5 min-h-5 text-xs">
            {strength && (
              <>
                <span className="text-slate-500">Strength: </span>
                <strong className={cx('font-semibold', strength.tone)}>{strength.label}</strong>
                {strength.note && <span className="text-slate-500"> · {strength.note}</span>}
              </>
            )}
          </p>
        </div>
        <PasswordInput label="Confirm new password" value={values.confirm} onChange={set('confirm')} error={errors.confirm} required autoComplete="new-password" maxLength={200} />
        <div className="flex justify-end pt-1">
          <Button type="submit" busy={busy} disabled={!values.current || !values.next || !values.confirm}>
            {busy ? 'Changing…' : 'Change password'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

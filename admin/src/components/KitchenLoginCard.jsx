import { useState } from 'react';
import { Button } from './Button.jsx';
import { Card, CardHeader } from './Card.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import { Alert } from './EmptyState.jsx';
import { focusFirstInvalid, Input, PasswordInput } from './Field.jsx';
import { useToast } from './Toast.jsx';
import { api, splitFieldErrors } from '../lib/api.js';
import { useQuery } from '../lib/hooks.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The kitchen's own login: an email and a password that open the kitchen screen and nothing else (not the menu, payments, reports or settings).
 * Give it to whoever runs the kitchen tablet. Changing the password signs the kitchen out; removing the login ends it at once.
 */
export default function KitchenLoginCard() {
  const toast = useToast();
  const q = useQuery(() => api('/api/admin/kitchen-login'), []);
  const login = q.data;
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  const open = () => {
    setValues({ email: login?.email ?? '', password: '' });
    setErrors({});
    setFormError(null);
    setEditing(true);
  };
  const set = (key) => (e) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    setErrors((er) => ({ ...er, [key]: undefined }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const found = {};
    if (!EMAIL_RE.test(values.email.trim())) found.email = 'Enter a valid email address.';
    if (!login?.configured && values.password.length < 8) found.password = 'Choose a password of at least 8 characters.';
    else if (values.password && values.password.length < 8) found.password = 'Use at least 8 characters.';
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) {
      focusFirstInvalid(form);
      return;
    }
    setBusy(true);
    try {
      await api('/api/admin/kitchen-login', { method: 'PUT', body: { email: values.email.trim(), ...(values.password ? { password: values.password } : {}) } });
      toast.success(login?.configured ? 'Kitchen login saved.' : 'Kitchen login created.');
      setEditing(false);
      q.reload();
    } catch (error) {
      const split = splitFieldErrors(error, ['email', 'password']);
      const emailIssue = error?.code === 'EMAIL_UNAVAILABLE';
      setErrors(emailIssue ? { ...split.fields, email: error.message } : { ...split.fields, ...(error?.code === 'PASSWORD_REQUIRED' ? { password: error.message } : {}) });
      setFormError(emailIssue || error?.code === 'PASSWORD_REQUIRED' ? null : split.formError);
      requestAnimationFrame(() => focusFirstInvalid(form));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="section" aria-labelledby="kitchen-login">
      <CardHeader id="kitchen-login" title="Kitchen login" description="A sign-in for the kitchen tablet. It opens the kitchen screen and nothing else: no menu, payments, reports or settings." />
      <div className="space-y-4 p-4 sm:p-5">
        {q.loading && <p className="text-sm text-slate-500">Loading…</p>}
        {!q.loading && !login && <Alert>Couldn&rsquo;t load the kitchen login. {q.error?.message}</Alert>}

        {login && !editing && (
          <>
            {login.configured ? (
              <p className="text-sm text-slate-700">
                The kitchen signs in with <strong className="font-semibold text-slate-900">{login.email}</strong> and the password you chose. After signing in it goes straight to the kitchen screen.
              </p>
            ) : (
              <p className="text-sm text-slate-600">There is no kitchen login yet. Create one and sign in on the kitchen tablet with it, instead of with your own login.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={open}>{login.configured ? 'Change email or password' : 'Create kitchen login'}</Button>
              {login.configured && (
                <Button variant="danger-outline" onClick={() => setRemoving(true)}>
                  Remove…
                </Button>
              )}
            </div>
          </>
        )}

        {login && editing && (
          <form onSubmit={submit} noValidate className="space-y-4">
            {formError && <Alert>{formError}</Alert>}
            <Input
              label="Kitchen email"
              name="kitchen-email"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
              value={values.email}
              onChange={set('email')}
              error={errors.email}
              hint="What the kitchen types to sign in. It must not be used by any other login."
              required
              data-autofocus
            />
            <PasswordInput
              label={login.configured ? 'New password (leave empty to keep the current one)' : 'Password'}
              name="kitchen-password"
              autoComplete="new-password"
              value={values.password}
              onChange={set('password')}
              error={errors.password}
              hint={login.configured ? 'A new password signs the kitchen out of every tablet.' : 'At least 8 characters. Tell the kitchen yourself; it is not shown again.'}
              maxLength={200}
            />
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" busy={busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        )}
      </div>

      <ConfirmDialog
        open={removing}
        title="Remove the kitchen login?"
        message="The kitchen is signed out at once and cannot sign in again until you create a new login."
        confirmLabel="Remove login"
        onCancel={() => setRemoving(false)}
        onConfirm={async () => {
          await api('/api/admin/kitchen-login', { method: 'DELETE' });
          toast.success('Kitchen login removed.');
          setRemoving(false);
          setEditing(false);
          q.reload();
        }}
      />
    </Card>
  );
}

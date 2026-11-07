import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AuthLayout from '../components/AuthLayout.jsx';
import { Button } from '../components/Button.jsx';
import { Alert } from '../components/EmptyState.jsx';
import { focusFirstInvalid, PasswordInput } from '../components/Field.jsx';
import { api, splitFieldErrors } from '../lib/api.js';
import { useAction, useDocumentTitle } from '../lib/hooks.js';

export default function ResetPassword() {
  useDocumentTitle('Choose a new password');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [run, busy] = useAction();
  const [values, setValues] = useState({ password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [linkBad, setLinkBad] = useState(token.length < 20);

  const set = (field) => (e) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const found = {};
    if (values.password.length < 8) found.password = 'Use at least 8 characters.';
    if (values.confirm !== values.password) found.confirm = "The two passwords don't match.";
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) {
      focusFirstInvalid(form);
      return;
    }
    run(async () => {
      try {
        await api('/api/auth/reset-password', { method: 'POST', body: { token, password: values.password }, auth: false });
        navigate('/login', { replace: true, state: { passwordReset: true } });
      } catch (err) {
        if (err.code === 'INVALID_RESET_TOKEN') {
          setLinkBad(true);
          return;
        }
        const { fields, formError: message } = splitFieldErrors(err, ['password']);
        setErrors(fields);
        setFormError(message);
        if (Object.keys(fields).length) focusFirstInvalid(form);
      }
    });
  };

  if (linkBad) {
    return (
      <AuthLayout title="This link doesn't work" subtitle="It may have expired, or it was already used.">
        <div className="mt-6 space-y-4">
          <Button className="w-full" size="lg" onClick={() => navigate('/forgot-password')}>
            Send me a new link
          </Button>
          <p className="text-center text-sm text-slate-600">
            <Link to="/login" className="font-semibold text-brand-700 underline-offset-2 hover:underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password" subtitle="You'll use it the next time you sign in.">
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        {formError && <Alert>{formError}</Alert>}
        <PasswordInput
          label="New password"
          name="password"
          autoComplete="new-password"
          value={values.password}
          onChange={set('password')}
          error={errors.password}
          hint="At least 8 characters."
          required
        />
        <PasswordInput
          label="Type it again"
          name="confirm"
          autoComplete="new-password"
          value={values.confirm}
          onChange={set('confirm')}
          error={errors.confirm}
          required
        />
        <Button type="submit" size="lg" busy={busy} className="w-full">
          {busy ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    </AuthLayout>
  );
}

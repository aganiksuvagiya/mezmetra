import { useState } from 'react';
import { Link } from 'react-router-dom';
import AuthLayout from '../components/AuthLayout.jsx';
import { Button } from '../components/Button.jsx';
import { Alert } from '../components/EmptyState.jsx';
import { focusFirstInvalid, Input } from '../components/Field.jsx';
import { api, splitFieldErrors } from '../lib/api.js';
import { useAction, useDocumentTitle } from '../lib/hooks.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPassword() {
  useDocumentTitle('Forgot password');
  const [run, busy] = useAction();
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [formError, setFormError] = useState(null);
  const [sentTo, setSentTo] = useState(null);

  const onSubmit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const value = email.trim();
    setFormError(null);
    if (!EMAIL_RE.test(value)) {
      setError('Enter a valid email address.');
      focusFirstInvalid(form);
      return;
    }
    setError(null);
    run(async () => {
      try {
        await api('/api/auth/forgot-password', { method: 'POST', body: { email: value }, auth: false });
        setSentTo(value);
      } catch (err) {
        const { fields, formError: message } = splitFieldErrors(err, ['email']);
        setError(fields.email);
        setFormError(message);
      }
    });
  };

  if (sentTo) {
    return (
      <AuthLayout title="Check your email" subtitle={`If there is an account for ${sentTo}, we've sent a link to choose a new password.`}>
        <div className="mt-6 space-y-4">
          <Alert tone="info">The link works once and expires in an hour. Nothing arrived? Check the spam folder, or wait a minute and try again.</Alert>
          <Button variant="secondary" className="w-full" onClick={() => setSentTo(null)}>
            Use a different email
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
    <AuthLayout title="Forgot your password?" subtitle="Enter the email you signed up with and we'll send you a link to choose a new one.">
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        {formError && <Alert>{formError}</Alert>}
        <Input
          label="Email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
          error={error}
          required
        />
        <Button type="submit" size="lg" busy={busy} className="w-full">
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        <Link to="/login" className="font-semibold text-brand-700 underline-offset-2 hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

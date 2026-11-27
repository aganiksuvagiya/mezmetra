import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { splitFieldErrors } from '../lib/api.js';
import { useAction, useDocumentTitle } from '../lib/hooks.js';
import { Button } from '../components/Button.jsx';
import { Alert } from '../components/EmptyState.jsx';
import { focusFirstInvalid, Input, PasswordInput } from '../components/Field.jsx';
import AuthLayout from '../components/AuthLayout.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The sign-in form. There is no public sign-up: a restaurant's login is created by the MezMitra team. */
export default function AuthForm() {
  useDocumentTitle('Sign in');

  const { login, expired } = useAuth();
  const passwordReset = useLocation().state?.passwordReset === true;
  const [run, busy] = useAction();
  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  // Asked for after the password, when the account has two-step sign-in.
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState('');

  const set = (field) => (e) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!EMAIL_RE.test(values.email.trim())) next.email = 'Enter a valid email address.';
    if (!values.password) next.password = 'Enter your password.';
    if (needsCode && !code.trim()) next.otp = 'Enter the code from your authenticator app.';
    return next;
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const found = validate();
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length) {
      focusFirstInvalid(form);
      return;
    }
    run(async () => {
      try {
        await login(values.email.trim(), values.password, needsCode ? code.trim() : undefined);
        // On success AuthProvider flips to "authed" and the route guard redirects.
      } catch (error) {
        if (error.code === 'OTP_REQUIRED') {
          setNeedsCode(true);
          return;
        }
        if (error.code === 'OTP_WRONG') {
          setErrors({ otp: error.message });
          focusFirstInvalid(form);
          return;
        }
        const { fields, formError } = splitFieldErrors(error, ['email', 'password']);
        setErrors(fields);
        setServerError(formError);
        if (Object.keys(fields).length) focusFirstInvalid(form);
      }
    });
  };

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to manage your restaurant.">
      {passwordReset && !serverError && (
        <Alert tone="success" className="mt-5">
          Your password was changed. Sign in with the new one.
        </Alert>
      )}
      {expired && !serverError && (
        <Alert tone="warning" className="mt-5">
          Your session has expired. Please sign in again.
        </Alert>
      )}

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        {serverError && <Alert>{serverError}</Alert>}
        <Input
          label="Email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          value={values.email}
          onChange={set('email')}
          error={errors.email}
          required
        />
        <PasswordInput
          label="Password"
          name="password"
          autoComplete="current-password"
          value={values.password}
          onChange={set('password')}
          error={errors.password}
          required
        />
        {needsCode && (
          <Input
            label="Code from your authenticator app"
            name="otp"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setErrors((prev) => ({ ...prev, otp: undefined }));
            }}
            error={errors.otp}
            hint="6 digits. Lost your phone? Type one of your recovery codes."
            required
          />
        )}
        <p className="-mt-2 text-right text-sm">
          <Link to="/forgot-password" className="font-medium text-brand-700 underline-offset-2 hover:underline">
            Forgot password?
          </Link>
        </p>
        <Button type="submit" size="lg" busy={busy} className="w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-600">New restaurant? Your MezMitra login is created for you by the MezMitra team.</p>
    </AuthLayout>
  );
}

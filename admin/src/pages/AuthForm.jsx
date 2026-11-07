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

export default function AuthForm({ mode }) {
  const isSignup = mode === 'signup';
  useDocumentTitle(isSignup ? 'Create your account' : 'Sign in');

  const { login, signup, expired } = useAuth();
  const passwordReset = useLocation().state?.passwordReset === true;
  const [run, busy] = useAction();
  const [values, setValues] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);

  const set = (field) => (e) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (isSignup && values.name.trim().length < 2) next.name = 'Enter your restaurant name (at least 2 characters).';
    if (!EMAIL_RE.test(values.email.trim())) next.email = 'Enter a valid email address.';
    if (!values.password) next.password = 'Enter your password.';
    else if (isSignup && values.password.length < 8) next.password = 'Use at least 8 characters.';
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
        if (isSignup) await signup(values.name.trim(), values.email.trim(), values.password);
        else await login(values.email.trim(), values.password);
        // On success AuthProvider flips to "authed" and the route guard redirects.
      } catch (error) {
        const { fields, formError } = splitFieldErrors(error, ['name', 'email', 'password']);
        setErrors(fields);
        setServerError(formError);
        if (Object.keys(fields).length) focusFirstInvalid(form);
      }
    });
  };

  return (
    <AuthLayout
      title={isSignup ? 'Create your account' : 'Welcome back'}
      subtitle={isSignup ? 'Set up your restaurant in a couple of minutes.' : 'Sign in to manage your restaurant.'}
    >
      {passwordReset && !serverError && !isSignup && (
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
        {isSignup && (
          <Input
            label="Restaurant name"
            name="name"
            autoComplete="organization"
            value={values.name}
            onChange={set('name')}
            error={errors.name}
            required
            maxLength={100}
          />
        )}
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
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          value={values.password}
          onChange={set('password')}
          error={errors.password}
          hint={isSignup ? 'At least 8 characters.' : undefined}
          required
        />
        {!isSignup && (
          <p className="-mt-2 text-right text-sm">
            <Link to="/forgot-password" className="font-medium text-brand-700 underline-offset-2 hover:underline">
              Forgot password?
            </Link>
          </p>
        )}
        <Button type="submit" size="lg" busy={busy} className="w-full">
          {busy ? (isSignup ? 'Creating account…' : 'Signing in…') : isSignup ? 'Create account' : 'Sign in'}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-600">
        {isSignup ? 'Already have an account?' : 'New to MezMitra?'}{' '}
        <Link to={isSignup ? '/login' : '/signup'} className="font-semibold text-brand-700 underline-offset-2 hover:underline">
          {isSignup ? 'Sign in' : 'Create an account'}
        </Link>
      </p>
    </AuthLayout>
  );
}

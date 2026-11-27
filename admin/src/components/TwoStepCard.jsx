import { useState } from 'react';
import { Button } from './Button.jsx';
import { Card, CardHeader } from './Card.jsx';
import { Alert } from './EmptyState.jsx';
import { focusFirstInvalid, Input, PasswordInput } from './Field.jsx';
import { useToast } from './Toast.jsx';
import { api } from '../lib/api.js';
import { useAction, useQuery } from '../lib/hooks.js';

/**
 * Two-step sign-in: after the password, a code from an authenticator app. Turning it on: password, scan the QR code, type the code
 * the app shows, keep the recovery codes. Turning it off: password and a code.
 */
export default function TwoStepCard() {
  const toast = useToast();
  const q = useQuery(() => api('/api/auth/2fa'), []);
  const [run, busy] = useAction();
  const [step, setStep] = useState('idle'); // idle | password | scan | codes | off
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState(null); // { secret, qr }
  const [codes, setCodes] = useState([]);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);

  const reset = (next = 'idle') => {
    setStep(next);
    setPassword('');
    setCode('');
    setErrors({});
    setFormError(null);
  };

  const send = (form, call) =>
    run(async () => {
      setErrors({});
      setFormError(null);
      try {
        await call();
      } catch (error) {
        if (error.code === 'WRONG_PASSWORD') setErrors({ password: error.message });
        else if (error.code === 'OTP_WRONG') setErrors({ code: error.message });
        else setFormError(error.message);
        requestAnimationFrame(() => focusFirstInvalid(form));
      }
    });

  const submit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (step === 'password') {
      send(form, async () => {
        setSetup(await api('/api/auth/2fa/setup', { method: 'POST', body: { password } }));
        reset('scan');
      });
    } else if (step === 'scan') {
      send(form, async () => {
        const done = await api('/api/auth/2fa/enable', { method: 'POST', body: { code: code.trim() } });
        setCodes(done.recovery_codes);
        setSetup(null);
        reset('codes');
        q.reload();
      });
    } else if (step === 'off') {
      send(form, async () => {
        await api('/api/auth/2fa/disable', { method: 'POST', body: { password, code: code.trim() } });
        reset();
        toast.success('Two-step sign-in is off.');
        q.reload();
      });
    }
  };

  const enabled = q.data?.enabled;
  const codeField = (
    <Input
      label={step === 'off' ? 'Code' : '6-digit code'}
      value={code}
      onChange={(e) => setCode(e.target.value)}
      error={errors.code}
      inputMode={step === 'off' ? undefined : 'numeric'} // switching off also takes a recovery code, which has letters
      autoComplete="one-time-code"
      required
      wrapperClassName="max-w-48"
      hint={step === 'off' ? 'From the app, or a recovery code.' : 'The code the app shows now.'}
    />
  );
  const passwordField = (
    <PasswordInput label="Your password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} autoComplete="current-password" required />
  );

  return (
    <Card as="section" aria-labelledby="two-step">
      <CardHeader id="two-step" title="Two-step sign-in" description="After your password, a code from an app on your phone. A stolen password alone is then not enough." />
      <div className="space-y-4 p-4 sm:p-5">
        {q.loading && <p className="text-sm text-slate-500">Loading…</p>}
        {!q.loading && !q.data && <Alert>Couldn&rsquo;t load this. {q.error?.message}</Alert>}

        {q.data && step === 'idle' && (
          <>
            <p className="text-sm text-slate-700">
              {enabled
                ? `On. ${q.data.recovery_codes_left} recovery ${q.data.recovery_codes_left === 1 ? 'code' : 'codes'} left.`
                : 'Off. We recommend turning it on, above all for the account that runs the platform.'}
            </p>
            <Button variant={enabled ? 'danger-outline' : 'primary'} onClick={() => reset(enabled ? 'off' : 'password')}>
              {enabled ? 'Turn off…' : 'Turn on'}
            </Button>
          </>
        )}

        {step === 'codes' && (
          <>
            <Alert tone="success">Two-step sign-in is on.</Alert>
            <p className="text-sm text-slate-700">
              <strong>Write these recovery codes down now.</strong> Each works once, in place of the app&rsquo;s code, if you lose your phone. They are not shown again.
            </p>
            <ul className="grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 font-mono text-sm tracking-wide text-slate-900">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Button
              onClick={() => {
                setCodes([]);
                reset();
              }}
            >
              I have saved them
            </Button>
          </>
        )}

        {(step === 'password' || step === 'scan' || step === 'off') && (
          <form onSubmit={submit} noValidate className="space-y-4">
            {formError && <Alert>{formError}</Alert>}
            {step === 'password' && passwordField}
            {step === 'scan' && setup && (
              <>
                <p className="text-sm text-slate-700">
                  Open Google Authenticator, Microsoft Authenticator or any similar app, add an account, and scan this code.
                </p>
                <img src={setup.qr} alt="QR code for your authenticator app" width="200" height="200" className="rounded-xl border border-slate-200 bg-white p-2" />
                <p className="break-all text-xs text-slate-500">
                  Can&rsquo;t scan? Type this key into the app: <span className="font-mono text-slate-800">{setup.secret}</span>
                </p>
                {codeField}
              </>
            )}
            {step === 'off' && (
              <>
                {passwordField}
                {codeField}
              </>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={() => reset()}>
                Cancel
              </Button>
              <Button type="submit" variant={step === 'off' ? 'danger' : 'primary'} busy={busy}>
                {step === 'password' ? 'Continue' : step === 'scan' ? 'Turn on' : 'Turn off'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

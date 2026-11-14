import { useState } from 'react';
import { Badge } from '../components/Badge.jsx';
import { Button } from '../components/Button.jsx';
import { Card, CardHeader, PageHeader } from '../components/Card.jsx';
import { Alert, ErrorState } from '../components/EmptyState.jsx';
import { focusFirstInvalid, Input, PasswordInput, SwitchField } from '../components/Field.jsx';
import { ExternalIcon, PlugIcon } from '../components/icons.jsx';
import { Skeleton } from '../components/Spinner.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, splitFieldErrors } from '../lib/api.js';
import { useAction, useDocumentTitle, useQuery } from '../lib/hooks.js';
import { methodsAvailable } from '../lib/payments.js';

const KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;
const APP_ID_RE = /^[A-Za-z0-9_-]{6,60}$/;
const UPI_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,48}$/;

// Cashfree's test (sandbox) App IDs start with TEST; every other one is a live account.
const cfModeOf = (appId) => (/^TEST/i.test(appId) ? 'test' : appId ? 'live' : null);
const modeOf = (keyId) => (keyId.startsWith('rzp_live_') ? 'live' : keyId.startsWith('rzp_test_') ? 'test' : null);

function ModeBadge({ mode }) {
  if (mode === 'live') return <Badge tone="red">Live mode</Badge>;
  if (mode === 'test') return <Badge tone="blue">Test mode</Badge>;
  return <Badge tone="slate">Not configured</Badge>;
}

function PaymentsForm({ settings, onSaved }) {
  const toast = useToast();
  const [saveAction, saving] = useAction();
  const [testAction, testing] = useAction();
  const [cfTestAction, cfTesting] = useAction();

  const [cash, setCash] = useState(settings.cash_enabled);
  const [online, setOnline] = useState(settings.razorpay_enabled);
  const [upi, setUpi] = useState(settings.upi_enabled);
  const [upiId, setUpiId] = useState(settings.upi_id ?? '');
  const [payButtons, setPayButtons] = useState(settings.upi_pay_buttons ?? false);
  const [keyId, setKeyId] = useState(settings.razorpay_key_id ?? '');
  const [secret, setSecret] = useState('');
  const [cashfree, setCashfree] = useState(settings.cashfree_enabled ?? false);
  const [cfAppId, setCfAppId] = useState(settings.cashfree_app_id ?? '');
  const [cfSecret, setCfSecret] = useState('');
  const [cfTestResult, setCfTestResult] = useState(null);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [testResult, setTestResult] = useState(null);

  // Only the ways of paying the product offers right now are shown (today: UPI only).
  const avail = methodsAvailable(settings);
  const showCash = avail.has('cash');
  const showRazorpay = avail.has('razorpay');
  const showCashfree = avail.has('cashfree');
  const upiOnly = avail.size === 1 && avail.has('upi');

  const savedKeyId = settings.razorpay_key_id ?? '';
  const keysChanged = showRazorpay && (keyId.trim() !== savedKeyId || secret.trim() !== '');
  const savedCfAppId = settings.cashfree_app_id ?? '';
  const cfChanged = showCashfree && (cfAppId.trim() !== savedCfAppId || cfSecret.trim() !== '');
  const cfMode = cfModeOf(cfAppId.trim() || savedCfAppId);
  const upiChanged = upi !== settings.upi_enabled || upiId.trim() !== (settings.upi_id ?? '') || payButtons !== (settings.upi_pay_buttons ?? false);
  const dirty =
    (showCash && cash !== settings.cash_enabled) ||
    (showRazorpay && online !== settings.razorpay_enabled) ||
    (showCashfree && cashfree !== (settings.cashfree_enabled ?? false)) ||
    keysChanged ||
    cfChanged ||
    upiChanged;
  const mode = modeOf(keyId.trim() || savedKeyId);

  const clearFeedback = () => {
    setTestResult(null);
    setCfTestResult(null);
    setFormError(null);
  };

  const validate = () => {
    const next = {};
    const id = keyId.trim();
    const sec = secret.trim();
    if (id) {
      if (!KEY_ID_RE.test(id)) next.keyId = 'Key ID looks like rzp_test_xxxxxxxx or rzp_live_xxxxxxxx.';
    } else if (savedKeyId) {
      next.keyId = 'A saved Key ID can’t be removed. Enter a new one to replace it.';
    }
    if (sec && sec.length < 8) next.secret = 'That Key Secret looks too short.';
    const vpa = upiId.trim();
    if (vpa && !UPI_RE.test(vpa)) next.upiId = 'A UPI ID looks like name@bank, e.g. shop@okhdfcbank or 9876543210@ybl.';
    if (upi && !vpa) next.upiId = 'Enter your UPI ID to turn on UPI payments.';
    const cid = cfAppId.trim();
    const csec = cfSecret.trim();
    if (cid) {
      if (!APP_ID_RE.test(cid)) next.cfAppId = 'The App ID is a short code of letters and numbers, from your Cashfree dashboard.';
    } else if (savedCfAppId) {
      next.cfAppId = 'A saved App ID can’t be removed. Enter a new one to replace it.';
    }
    if (csec && csec.length < 8) next.cfSecret = 'That Secret Key looks too short.';
    if (cashfree) {
      if (!cid && !savedCfAppId) next.cfAppId = 'Enter your Cashfree App ID to turn on online payments.';
      if (!csec && !settings.cashfree_secret_set) next.cfSecret = 'Enter your Cashfree Secret Key to turn on online payments.';
    }
    if (online) {
      if (!id && !savedKeyId) next.keyId = 'Enter your Razorpay Key ID to turn on online payments.';
      if (!sec && !settings.razorpay_secret_set) next.secret = 'Enter your Razorpay Key Secret to turn on online payments.';
    }
    return next;
  };

  const submit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearFeedback();
    if (!(showCash && cash) && !(showRazorpay && online) && !(showCashfree && cashfree) && !upi) {
      setErrors({});
      setFormError(
        upiOnly
          ? 'Turn on UPI payments and enter your UPI ID, or diners won’t be able to pay.'
          : 'Keep at least one payment method turned on, or diners won’t be able to pay.',
      );
      return;
    }
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) {
      focusFirstInvalid(form);
      return;
    }
    const body = {};
    if (cash !== settings.cash_enabled) body.cash_enabled = cash;
    if (online !== settings.razorpay_enabled) body.razorpay_enabled = online;
    if (showCashfree && cashfree !== (settings.cashfree_enabled ?? false)) body.cashfree_enabled = cashfree;
    if (upi !== settings.upi_enabled) body.upi_enabled = upi;
    if (upiId.trim() !== (settings.upi_id ?? '')) body.upi_id = upiId.trim();
    if (payButtons !== (settings.upi_pay_buttons ?? false)) body.upi_pay_buttons = payButtons;
    if (keyId.trim() && keyId.trim() !== savedKeyId) body.razorpay_key_id = keyId.trim();
    if (secret.trim()) body.razorpay_key_secret = secret.trim();
    if (cfAppId.trim() && cfAppId.trim() !== savedCfAppId) body.cashfree_app_id = cfAppId.trim();
    if (cfSecret.trim()) body.cashfree_secret = cfSecret.trim();
    if (Object.keys(body).length === 0) {
      toast.info('No changes to save.');
      return;
    }
    saveAction(async () => {
      try {
        const saved = await api('/api/admin/payment-settings', { method: 'PUT', body });
        toast.success('Payment settings saved.');
        onSaved(saved);
      } catch (error) {
        const { fields, formError: message } = splitFieldErrors(error, ['razorpay_key_id', 'razorpay_key_secret', 'upi_id', 'cashfree_app_id', 'cashfree_secret']);
        setErrors({
          keyId: fields.razorpay_key_id,
          secret: fields.razorpay_key_secret,
          upiId: fields.upi_id,
          cfAppId: fields.cashfree_app_id,
          cfSecret: fields.cashfree_secret,
        });
        setFormError(message);
        if (Object.keys(fields).length) focusFirstInvalid(form);
      }
    });
  };

  const testConnection = () =>
    testAction(async () => {
      setTestResult(null);
      try {
        const result = await api('/api/admin/payment-settings/test', { method: 'POST' });
        setTestResult({ ok: true, message: `Connected. Razorpay accepted your ${result.mode === 'live' ? 'live' : 'test'} keys.` });
      } catch (error) {
        setTestResult({ ok: false, message: error.message });
      }
    });

  const testCashfree = () =>
    cfTestAction(async () => {
      setCfTestResult(null);
      try {
        const result = await api('/api/admin/payment-settings/test', { method: 'POST', body: { provider: 'cashfree' } });
        setCfTestResult({ ok: true, message: `Connected. Cashfree accepted your ${result.mode === 'live' ? 'live' : 'test'} keys.` });
      } catch (error) {
        setCfTestResult({ ok: false, message: error.message });
      }
    });

  const canTest = settings.razorpay_configured && !keysChanged;
  const canTestCf = settings.cashfree_configured && !cfChanged;

  return (
    <form onSubmit={submit} noValidate className="space-y-4 sm:space-y-6">
      {formError && <Alert>{formError}</Alert>}

      <Card as="section" aria-labelledby="methods">
        <CardHeader
          id="methods"
          title="Payment methods"
          description={upiOnly ? 'Diners pay with a UPI app. Turn it on and enter your UPI ID below.' : 'Choose how diners can pay. At least one must stay on.'}
        />
        <div className="divide-y divide-slate-100 p-4 sm:p-5 [&>*]:py-5 [&>:first-child]:pt-0 [&>:last-child]:pb-0">
          {showCash && (
            <div>
              <SwitchField
                label="Pay at counter (cash)"
                description="Diners order from the table and pay staff at the counter. You record the payment in Orders."
                checked={cash}
                onChange={(v) => {
                  setCash(v);
                  clearFeedback();
                }}
              />
            </div>
          )}
          <div>
            <SwitchField
              label="UPI apps (Google Pay, PhonePe, Paytm…)"
              description="Diners tap their UPI app with the amount already filled in, pay, then tell us they paid. You confirm it in Orders."
              checked={upi}
              onChange={(v) => {
                setUpi(v);
                clearFeedback();
              }}
            />
          </div>
          {showCashfree && (
            <div>
              <SwitchField
                label="Online payments (Cashfree)"
                description="Diners pay by UPI, card or net banking on their phone, and the order is marked paid automatically once the money arrives. Needs your Cashfree keys below. Only one online gateway can be on at a time."
                checked={cashfree}
                onChange={(v) => {
                  setCashfree(v);
                  if (v) setOnline(false);
                  clearFeedback();
                }}
              />
            </div>
          )}
          {showRazorpay && (
            <div>
              <SwitchField
                label="Online payments (Razorpay)"
                description={`Diners pay by UPI, card or net banking on their phone. Needs your Razorpay keys below.${showCashfree ? ' Only one online gateway can be on at a time.' : ''}`}
                checked={online}
                onChange={(v) => {
                  setOnline(v);
                  if (v) setCashfree(false);
                  clearFeedback();
                }}
              />
            </div>
          )}
        </div>
      </Card>

      <Card as="section" aria-labelledby="upi">
        <CardHeader id="upi" title="UPI ID" description="Money from UPI apps goes straight to your UPI ID." />
        <div className="space-y-3 p-4 sm:p-5">
          <Input
            label="Your UPI ID"
            value={upiId}
            onChange={(e) => {
              setUpiId(e.target.value);
              setErrors((p) => ({ ...p, upiId: undefined }));
              clearFeedback();
            }}
            error={errors.upiId}
            placeholder="shopname@okhdfcbank"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="email"
            hint="Find it in your UPI app under your profile. Diners see it when they pay."
          />
          <SwitchField
            label="Show UPI app buttons (Google Pay, PhonePe, Paytm)"
            description="Turn this on only if your UPI ID is a business (merchant) ID. For an ordinary personal UPI ID, Google Pay and PhonePe usually refuse these buttons (“bank limit exceeded”, “security reasons”). With it off, diners pay by typing your UPI ID, which always works."
            checked={payButtons}
            onChange={(v) => {
              setPayButtons(v);
              clearFeedback();
            }}
          />
          <Alert tone="warning">
            A plain UPI link can’t tell us whether the payment went through, so each UPI order shows “Customer says paid” and you press
            <strong> Confirm payment</strong> after you see the money in your bank or UPI app. Some UPI apps may refuse a pre-filled amount for a
            personal UPI ID: <strong>Google Pay in particular blocks them</strong> with a “bank limit exceeded” message, while PhonePe and Paytm usually work. Diners can always pay manually (UPI ID + amount). {showRazorpay || showCashfree ? 'A merchant (business) UPI ID or online payments (below) is' : 'A merchant (business) UPI ID is'} the reliable fix.
          </Alert>
        </div>
      </Card>

      {showCashfree && (
        <Card as="section" aria-labelledby="cashfree">
          <CardHeader
            id="cashfree"
            title="Cashfree keys"
            description="Used to take online payments. Cashfree confirms each payment, so orders are marked paid by themselves."
            actions={<ModeBadge mode={cfMode} />}
          />
          <div className="space-y-4 p-4 sm:p-5">
            {cfMode === 'live' && (
              <Alert tone="warning">
                <strong>Live keys take real money.</strong> Every online payment from a diner will be charged to a real card or UPI account. Use test keys (the
                App ID starts with <code className="rounded bg-amber-100 px-1">TEST</code>) while you are trying things out.
              </Alert>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="App ID"
                value={cfAppId}
                onChange={(e) => {
                  setCfAppId(e.target.value);
                  setErrors((p) => ({ ...p, cfAppId: undefined }));
                  clearFeedback();
                }}
                error={errors.cfAppId}
                placeholder="TEST10xxxxxxxxxxxx"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                hint="Safe to show; it identifies your account."
              />
              <PasswordInput
                label="Secret Key"
                value={cfSecret}
                onChange={(e) => {
                  setCfSecret(e.target.value);
                  setErrors((p) => ({ ...p, cfSecret: undefined }));
                  clearFeedback();
                }}
                error={errors.cfSecret}
                placeholder={settings.cashfree_secret_set ? 'Saved – leave blank to keep' : 'Paste your Secret Key'}
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                hint={settings.cashfree_secret_set ? 'A secret is saved. It is stored encrypted and never shown again.' : 'Stored encrypted and never shown again.'}
              />
            </div>

            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 p-3">
              <Button variant="secondary" icon={PlugIcon} busy={cfTesting} disabled={!canTestCf} onClick={testCashfree}>
                {cfTesting ? 'Testing…' : 'Test connection'}
              </Button>
              <p className="min-w-0 flex-1 basis-48 text-xs text-slate-500">
                {!settings.cashfree_configured
                  ? 'Save your App ID and Secret Key first, then test them.'
                  : cfChanged
                    ? 'Save your changes first. The test uses the keys that are saved.'
                    : 'Makes one harmless call to Cashfree with your saved keys.'}
              </p>
            </div>
            {cfTestResult && (
              <Alert tone={cfTestResult.ok ? 'success' : 'error'} role="status">
                {cfTestResult.message}
              </Alert>
            )}

            <details className="group rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700">
              <summary className="cursor-pointer font-medium text-slate-900">Where do I find my Cashfree keys?</summary>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-slate-600">
                <li>
                  Sign in to the{' '}
                  <a href="https://merchant.cashfree.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 underline underline-offset-2">
                    Cashfree Merchant Dashboard <ExternalIcon size={13} />
                  </a>
                  .
                </li>
                <li>Use the Test / Production switch at the top to choose which keys you want.</li>
                <li>
                  Open <strong>Payment Gateway</strong>, then <strong>Developers</strong> and <strong>API Keys</strong>.
                </li>
                <li>
                  Generate (or view) your keys. Copy the <strong>App ID</strong> and the <strong>Secret Key</strong> into the fields above.
                </li>
                <li>The Secret Key is shown only once. If you lose it, generate a new one and paste the new pair here.</li>
              </ol>
              <p className="mt-3 text-xs text-slate-500">Start with the Test keys. Switch to Production keys only when Cashfree has approved your account for real payments.</p>
            </details>
          </div>
        </Card>
      )}

      {showRazorpay && (
      <Card as="section" aria-labelledby="razorpay">
        <CardHeader
          id="razorpay"
          title="Razorpay keys"
          description="Used to take online payments."
          actions={<ModeBadge mode={mode} />}
        />
        <div className="space-y-4 p-4 sm:p-5">
          {mode === 'live' && (
            <Alert tone="warning">
              <strong>Live keys take real money.</strong> Every online payment from a diner will be charged to a real card or UPI account. Use test keys (starting
              with <code className="rounded bg-amber-100 px-1">rzp_test_</code>) while you are trying things out.
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Key ID"
              value={keyId}
              onChange={(e) => {
                setKeyId(e.target.value);
                setErrors((p) => ({ ...p, keyId: undefined }));
                clearFeedback();
              }}
              error={errors.keyId}
              placeholder="rzp_test_xxxxxxxxxxxxxx"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              hint="Safe to show; it identifies your account."
            />
            <PasswordInput
              label="Key Secret"
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                setErrors((p) => ({ ...p, secret: undefined }));
                clearFeedback();
              }}
              error={errors.secret}
              placeholder={settings.razorpay_secret_set ? 'Saved – leave blank to keep' : 'Paste your Key Secret'}
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              hint={settings.razorpay_secret_set ? 'A secret is saved. It is stored encrypted and never shown again.' : 'Stored encrypted and never shown again.'}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 p-3">
            <Button variant="secondary" icon={PlugIcon} busy={testing} disabled={!canTest} onClick={testConnection}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            <p className="min-w-0 flex-1 basis-48 text-xs text-slate-500">
              {!settings.razorpay_configured
                ? 'Save your Key ID and Key Secret first, then test them.'
                : keysChanged
                  ? 'Save your changes first. The test uses the keys that are saved.'
                  : 'Makes one harmless call to Razorpay with your saved keys.'}
            </p>
          </div>
          {testResult && (
            <Alert tone={testResult.ok ? 'success' : 'error'} role="status">
              {testResult.message}
            </Alert>
          )}

          <details className="group rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700">
            <summary className="cursor-pointer font-medium text-slate-900">Where do I find my Razorpay keys?</summary>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-slate-600">
              <li>
                Sign in to the{' '}
                <a href="https://dashboard.razorpay.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 underline underline-offset-2">
                  Razorpay Dashboard <ExternalIcon size={13} />
                </a>
                .
              </li>
              <li>Use the Test Mode / Live Mode switch at the top to choose which keys you want.</li>
              <li>
                Open <strong>Account &amp; Settings</strong> and choose <strong>API Keys</strong>.
              </li>
              <li>
                Click <strong>Generate Key</strong>. Copy the <strong>Key ID</strong> and the <strong>Key Secret</strong> into the fields above.
              </li>
              <li>The secret is shown only once. If you lose it, generate a new key and paste the new pair here.</li>
            </ol>
            <p className="mt-3 text-xs text-slate-500">Start with Test Mode keys. Switch to Live keys only when you are ready to accept real payments.</p>
          </details>
        </div>
      </Card>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {dirty && <span className="text-sm text-slate-500">You have unsaved changes.</span>}
        <Button type="submit" size="lg" busy={saving} disabled={!dirty}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

export default function Payments() {
  useDocumentTitle('Payments');
  const q = useQuery(() => api('/api/admin/payment-settings'), []);
  const [version, setVersion] = useState(0);

  return (
    <>
      <PageHeader title="Payments" description="Control how diners pay for their orders." />
      {q.loading && (
        <div role="status" aria-label="Loading payment settings" className="space-y-4">
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      )}
      {!q.loading && !q.data && (
        <Card>
          <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load payment settings" />
        </Card>
      )}
      {q.data && (
        <PaymentsForm
          key={version}
          settings={q.data}
          onSaved={(saved) => {
            q.setData(saved);
            setVersion((v) => v + 1); // re-seed the form from what the server now has (and clear the secret field)
          }}
        />
      )}
    </>
  );
}

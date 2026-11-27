import { useState } from 'react';
import { Badge } from '../components/Badge.jsx';
import { Button } from '../components/Button.jsx';
import { Card, CardHeader, PageHeader } from '../components/Card.jsx';
import { Alert, ErrorState } from '../components/EmptyState.jsx';
import { focusFirstInvalid, Input, PasswordInput, SwitchField } from '../components/Field.jsx';
import { ExternalIcon, PlugIcon } from '../components/icons.jsx';
import { Skeleton } from '../components/Spinner.jsx';
import WebhookBox from '../components/WebhookBox.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, splitFieldErrors } from '../lib/api.js';
import { useAction, useDocumentTitle, useQuery } from '../lib/hooks.js';
import { methodsAvailable } from '../lib/payments.js';

const KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;
const PP_ID_RE = /^[A-Za-z0-9_.-]{4,80}$/;
const PP_VERSION_RE = /^[A-Za-z0-9_.-]{1,10}$/;
const modeOf = (keyId) => (keyId.startsWith('rzp_live_') ? 'live' : keyId.startsWith('rzp_test_') ? 'test' : null);

function ModeBadge({ mode }) {
  if (mode === 'live') return <Badge tone="red">Live mode</Badge>;
  if (mode === 'test') return <Badge tone="blue">Test mode</Badge>;
  return <Badge tone="slate">Not configured</Badge>;
}

/** The "Test connection" row under a gateway's keys. */
function TestRow({ gateway, configured, changed, busy, onTest, result, what }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 p-3">
        <Button variant="secondary" icon={PlugIcon} busy={busy} disabled={!configured || changed} onClick={onTest}>
          {busy ? 'Testing…' : 'Test connection'}
        </Button>
        <p className="min-w-0 flex-1 basis-48 text-xs text-slate-500">
          {!configured ? `Save your ${what} first, then test them.` : changed ? 'Save your changes first. The test uses the keys that are saved.' : `Makes one harmless call to ${gateway} with your saved keys.`}
        </p>
      </div>
      {result && (
        <Alert tone={result.ok ? 'success' : 'error'} role="status">
          {result.message}
        </Alert>
      )}
    </>
  );
}

function PaymentsForm({ settings, onSaved }) {
  const toast = useToast();
  const [saveAction, saving] = useAction();
  const [testAction, testing] = useAction();
  const [ppTestAction, ppTesting] = useAction();

  const [cash, setCash] = useState(settings.cash_enabled);
  const [online, setOnline] = useState(settings.razorpay_enabled);
  const [keyId, setKeyId] = useState(settings.razorpay_key_id ?? '');
  const [secret, setSecret] = useState('');
  const [phonepe, setPhonepe] = useState(settings.phonepe_enabled ?? false);
  const [ppClientId, setPpClientId] = useState(settings.phonepe_client_id ?? '');
  const [ppVersion, setPpVersion] = useState(settings.phonepe_client_version ?? '');
  const [ppSecret, setPpSecret] = useState('');
  const [ppTestResult, setPpTestResult] = useState(null);
  // Webhook secrets (write-only): typed once, here and in the gateway's dashboard.
  const [rzHookSecret, setRzHookSecret] = useState('');
  const [ppHookUser, setPpHookUser] = useState('');
  const [ppHookPass, setPpHookPass] = useState('');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [testResult, setTestResult] = useState(null);

  // Only the ways of paying the product offers right now are shown.
  const avail = methodsAvailable(settings);
  const showCash = avail.has('cash');
  const showRazorpay = avail.has('razorpay');
  const showPhonepe = avail.has('phonepe');

  const savedKeyId = settings.razorpay_key_id ?? '';
  // The live server takes no Razorpay test keys (a test payment moves no money).
  const liveOnly = Boolean(settings.razorpay_live_only);
  const savedTestKey = liveOnly && modeOf(savedKeyId) === 'test';
  const keysChanged = showRazorpay && (keyId.trim() !== savedKeyId || secret.trim() !== '');
  const savedPpId = settings.phonepe_client_id ?? '';
  const savedPpVersion = settings.phonepe_client_version ?? '';
  const ppChanged = showPhonepe && (ppClientId.trim() !== savedPpId || ppVersion.trim() !== savedPpVersion || ppSecret.trim() !== '');
  const hooksChanged = (showRazorpay && rzHookSecret.trim() !== '') || (showPhonepe && (ppHookUser.trim() !== '' || ppHookPass.trim() !== ''));
  const dirty =
    hooksChanged ||
    (showCash && cash !== settings.cash_enabled) ||
    (showRazorpay && online !== settings.razorpay_enabled) ||
    (showPhonepe && phonepe !== (settings.phonepe_enabled ?? false)) ||
    keysChanged ||
    ppChanged;
  const mode = modeOf(keyId.trim() || savedKeyId);

  const clearFeedback = () => {
    setTestResult(null);
    setPpTestResult(null);
    setFormError(null);
  };

  const validate = () => {
    const next = {};
    const id = keyId.trim();
    const sec = secret.trim();
    if (id) {
      if (!KEY_ID_RE.test(id)) next.keyId = `Key ID looks like ${liveOnly ? '' : 'rzp_test_xxxxxxxx or '}rzp_live_xxxxxxxx.`;
      // A test key saved earlier does not stop other changes, as long as online payments stay off.
      else if (liveOnly && modeOf(id) === 'test' && (online || id !== savedKeyId)) {
        next.keyId = 'Test keys do not work on the live site. Enter a Key ID that starts with rzp_live_.';
      }
    } else if (savedKeyId) {
      next.keyId = 'A saved Key ID can’t be removed. Enter a new one to replace it.';
    }
    if (sec && sec.length < 8) next.secret = 'That Key Secret looks too short.';
    const ppId = ppClientId.trim();
    const ppVer = ppVersion.trim();
    const ppSec = ppSecret.trim();
    if (showPhonepe) {
      if (ppId && !PP_ID_RE.test(ppId)) next.ppClientId = 'The Client ID is the code from your PhonePe Business dashboard (letters, numbers, - _ .).';
      if (ppVer && !PP_VERSION_RE.test(ppVer)) next.ppVersion = 'The Client Version is a short value such as 1.';
      if (ppSec && ppSec.length < 8) next.ppSecret = 'That Client Secret looks too short.';
      if (phonepe) {
        if (!ppId && !savedPpId) next.ppClientId = 'Enter your PhonePe Client ID to turn on online payments.';
        if (!ppVer) next.ppVersion = 'Enter your PhonePe Client Version (usually 1).';
        if (!ppSec && !settings.phonepe_secret_set) next.ppSecret = 'Enter your PhonePe Client Secret to turn on online payments.';
      }
    }
    if (showRazorpay && online) {
      if (!id && !savedKeyId) next.keyId = 'Enter your Razorpay Key ID to turn on online payments.';
      if (!sec && !settings.razorpay_secret_set) next.secret = 'Enter your Razorpay Key Secret to turn on online payments.';
    }
    return next;
  };

  const submit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearFeedback();
    if (!(showCash && cash) && !(showRazorpay && online) && !(showPhonepe && phonepe)) {
      setErrors({});
      setFormError('Keep at least one payment method turned on, or diners won’t be able to pay.');
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
    if (keyId.trim() && keyId.trim() !== savedKeyId) body.razorpay_key_id = keyId.trim();
    if (secret.trim()) body.razorpay_key_secret = secret.trim();
    if (showPhonepe) {
      if (phonepe !== (settings.phonepe_enabled ?? false)) body.phonepe_enabled = phonepe;
      if (ppClientId.trim() && ppClientId.trim() !== savedPpId) body.phonepe_client_id = ppClientId.trim();
      if (ppVersion.trim() && ppVersion.trim() !== savedPpVersion) body.phonepe_client_version = ppVersion.trim();
      if (ppSecret.trim()) body.phonepe_client_secret = ppSecret.trim();
    }
    if (showRazorpay && rzHookSecret.trim()) body.razorpay_webhook_secret = rzHookSecret.trim();
    if (showPhonepe && (ppHookUser.trim() || ppHookPass.trim())) {
      body.phonepe_webhook_username = ppHookUser.trim();
      body.phonepe_webhook_password = ppHookPass.trim();
    }
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
        const { fields, formError: message } = splitFieldErrors(error, [
          'razorpay_key_id',
          'razorpay_key_secret',
          'phonepe_client_id',
          'phonepe_client_version',
          'phonepe_client_secret',
          'razorpay_webhook_secret',
          'phonepe_webhook_username',
          'phonepe_webhook_password',
        ]);
        setErrors({
          keyId: fields.razorpay_key_id,
          secret: fields.razorpay_key_secret,
          ppClientId: fields.phonepe_client_id,
          ppVersion: fields.phonepe_client_version,
          ppSecret: fields.phonepe_client_secret,
          rzHook: fields.razorpay_webhook_secret,
          ppHookUser: fields.phonepe_webhook_username,
          ppHookPass: fields.phonepe_webhook_password,
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

  const testPhonepe = () =>
    ppTestAction(async () => {
      setPpTestResult(null);
      try {
        await api('/api/admin/payment-settings/test', { method: 'POST', body: { provider: 'phonepe' } });
        setPpTestResult({ ok: true, message: 'Connected. PhonePe accepted your keys.' });
      } catch (error) {
        setPpTestResult({ ok: false, message: error.message });
      }
    });

  const canTest = settings.razorpay_configured && !keysChanged;

  return (
    <form onSubmit={submit} noValidate className="space-y-4 sm:space-y-6">
      {formError && <Alert>{formError}</Alert>}

      <Card as="section" aria-labelledby="methods">
        <CardHeader
          id="methods"
          title="Payment methods"
          description="Choose how diners can pay. At least one must stay on."
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
          {showRazorpay && (
            <div>
              <SwitchField
                label="Online payments (Razorpay)"
                description={`Diners pay by UPI, card or net banking on their phone. Needs your Razorpay keys below.${showPhonepe ? ' Only one online gateway can be on at a time.' : ''}`}
                checked={online}
                onChange={(v) => {
                  setOnline(v);
                  if (v) setPhonepe(false);
                  clearFeedback();
                }}
              />
            </div>
          )}
          {showPhonepe && (
            <div>
              <SwitchField
                label="Online payments (PhonePe)"
                description={`Diners are sent to PhonePe's secure page to pay by UPI, card or net banking, and the order is marked paid automatically once PhonePe confirms the money. Needs your PhonePe Business keys below.${showRazorpay ? ' Only one online gateway can be on at a time.' : ''}`}
                checked={phonepe}
                onChange={(v) => {
                  setPhonepe(v);
                  if (v) setOnline(false);
                  clearFeedback();
                }}
              />
            </div>
          )}
        </div>
      </Card>

      {showPhonepe && (
        <Card as="section" aria-labelledby="phonepe">
          <CardHeader
            id="phonepe"
            title="PhonePe keys"
            description="Used to take online payments. PhonePe confirms each payment, so orders are marked paid by themselves."
            actions={<ModeBadge mode={settings.phonepe_configured ? 'live' : null} />}
          />
          <div className="space-y-4 p-4 sm:p-5">
            <Alert tone="warning">
              <strong>Use your live keys.</strong> Every online payment from a diner is charged to a real card or UPI account. PhonePe test keys do not
              work here.
            </Alert>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Client ID"
                value={ppClientId}
                onChange={(e) => {
                  setPpClientId(e.target.value);
                  setErrors((p) => ({ ...p, ppClientId: undefined }));
                  clearFeedback();
                }}
                error={errors.ppClientId}
                placeholder="From the PhonePe Business dashboard"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                hint="Safe to show; it identifies your account."
              />
              <Input
                label="Client Version"
                value={ppVersion}
                onChange={(e) => {
                  setPpVersion(e.target.value);
                  setErrors((p) => ({ ...p, ppVersion: undefined }));
                  clearFeedback();
                }}
                error={errors.ppVersion}
                placeholder="1"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                hint="Usually 1."
                wrapperClassName="sm:max-w-40"
              />
            </div>
            <PasswordInput
              label="Client Secret"
              value={ppSecret}
              onChange={(e) => {
                setPpSecret(e.target.value);
                setErrors((p) => ({ ...p, ppSecret: undefined }));
                clearFeedback();
              }}
              error={errors.ppSecret}
              placeholder={settings.phonepe_secret_set ? 'Saved – leave blank to keep' : 'Paste your Client Secret'}
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              hint={settings.phonepe_secret_set ? 'A secret is saved. It is stored encrypted and never shown again.' : 'Stored encrypted and never shown again.'}
            />
            <TestRow
              gateway="PhonePe"
              what="Client ID, Version and Secret"
              configured={settings.phonepe_configured}
              changed={ppChanged}
              busy={ppTesting}
              result={ppTestResult}
              onTest={testPhonepe}
            />
            <WebhookBox
              url={settings.webhook_url_phonepe}
              isSet={settings.phonepe_webhook_set}
              steps={
                <>
                  <li>
                    In the PhonePe Business dashboard, open the <strong>Webhooks</strong> settings (under Developer settings).
                  </li>
                  <li>Paste the webhook address above as the URL.</li>
                  <li>Choose a username and a password of your own, type the same two below, and press Save here.</li>
                  <li>
                    Select the events <strong>checkout.order.completed</strong> and <strong>checkout.order.failed</strong>, and save in PhonePe.
                  </li>
                </>
              }
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Webhook username"
                  value={ppHookUser}
                  onChange={(e) => {
                    setPpHookUser(e.target.value);
                    setErrors((p) => ({ ...p, ppHookUser: undefined }));
                    clearFeedback();
                  }}
                  error={errors.ppHookUser}
                  placeholder={settings.phonepe_webhook_set ? 'Saved – leave blank to keep' : 'e.g. mezmitra-hook'}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <PasswordInput
                  label="Webhook password"
                  value={ppHookPass}
                  onChange={(e) => {
                    setPpHookPass(e.target.value);
                    setErrors((p) => ({ ...p, ppHookPass: undefined }));
                    clearFeedback();
                  }}
                  error={errors.ppHookPass}
                  placeholder={settings.phonepe_webhook_set ? 'Saved – leave blank to keep' : 'At least 8 characters'}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  hint="Stored encrypted and never shown again."
                />
              </div>
            </WebhookBox>
            <details className="group rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700">
              <summary className="cursor-pointer font-medium text-slate-900">Where do I find my PhonePe keys?</summary>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-slate-600">
                <li>
                  Sign in to the{' '}
                  <a href="https://business.phonepe.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 underline underline-offset-2">
                    PhonePe Business dashboard <ExternalIcon size={13} />
                  </a>
                  .
                </li>
                <li>
                  Open <strong>Developer Settings</strong> and make sure <strong>Test Mode</strong> is off, so you see your live keys.
                </li>
                <li>
                  Copy the <strong>Client ID</strong>, <strong>Client Version</strong> and <strong>Client Secret</strong> into the fields above.
                </li>
              </ol>
              <p className="mt-3 text-xs text-slate-500">PhonePe gives live keys once it has activated your account for payment gateway payments.</p>
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
          {savedTestKey ? (
            <Alert>
              <strong>The saved key is a test key, which does not work here.</strong> Enter your live Key ID and Key Secret to take online payments with
              Razorpay.
            </Alert>
          ) : liveOnly ? (
            <Alert tone="warning">
              <strong>Use your live keys.</strong> Every online payment from a diner is charged to a real card or UPI account. Razorpay test keys do not work
              here.
            </Alert>
          ) : (
            mode === 'live' && (
              <Alert tone="warning">
                <strong>Live keys take real money.</strong> Every online payment from a diner will be charged to a real card or UPI account. Use test keys
                (starting with <code className="rounded bg-amber-100 px-1">rzp_test_</code>) while you are trying things out.
              </Alert>
            )
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
              placeholder={liveOnly ? 'rzp_live_xxxxxxxxxxxxxx' : 'rzp_test_xxxxxxxxxxxxxx'}
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
                ? `Save your ${savedTestKey ? 'live ' : ''}Key ID and Key Secret first, then test them.`
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

          <WebhookBox
              url={settings.webhook_url_razorpay}
              isSet={settings.razorpay_webhook_set}
              steps={
                <>
                  <li>
                    In the Razorpay Dashboard, open <strong>Settings → Webhooks → Add New Webhook</strong>.
                  </li>
                  <li>Paste the webhook address above as the Webhook URL.</li>
                  <li>Type a secret of your own (at least 8 characters) in Razorpay, type the same secret below, and press Save here.</li>
                  <li>
                    Tick the events <strong>payment.captured</strong>, <strong>order.paid</strong> and <strong>qr_code.credited</strong>, and save in Razorpay.
                  </li>
                </>
              }
            >
              <PasswordInput
                label="Webhook secret"
                value={rzHookSecret}
                onChange={(e) => {
                  setRzHookSecret(e.target.value);
                  setErrors((p) => ({ ...p, rzHook: undefined }));
                  clearFeedback();
                }}
                error={errors.rzHook}
                placeholder={settings.razorpay_webhook_set ? 'Saved – leave blank to keep' : 'The secret you typed in Razorpay'}
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                hint="Stored encrypted and never shown again."
                wrapperClassName="max-w-md"
              />
            </WebhookBox>

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
              <li>{liveOnly ? 'Set the switch at the top to Live Mode.' : 'Use the Test Mode / Live Mode switch at the top to choose which keys you want.'}</li>
              <li>
                Open <strong>Account &amp; Settings</strong> and choose <strong>API Keys</strong>.
              </li>
              <li>
                Click <strong>Generate Key</strong>. Copy the <strong>Key ID</strong> and the <strong>Key Secret</strong> into the fields above.
              </li>
              <li>The secret is shown only once. If you lose it, generate a new key and paste the new pair here.</li>
            </ol>
            <p className="mt-3 text-xs text-slate-500">
              {liveOnly
                ? 'Razorpay gives live keys once it has activated your account for payments.'
                : 'Start with Test Mode keys. Switch to Live keys only when you are ready to accept real payments.'}
            </p>
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
      {/* A settings form reads better narrow than stretched across the whole screen. */}
      <div className="max-w-3xl">
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
      </div>
    </>
  );
}

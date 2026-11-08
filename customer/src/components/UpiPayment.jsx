import { useEffect, useId, useState } from 'react';
import Alert from './Alert';
import { Button, buttonClass } from './Button';
import { CheckIcon, ClockIcon, CopyIcon, PhoneIcon } from './Icons';
import { useToast } from './Toast';
import { claimUpiPayment, errorMessage } from '../lib/api';
import { formatMoney } from '../lib/money';

const REFERENCE_RE = /^[A-Za-z0-9]{6,30}$/;
const launchKey = (token) => `mezmitra_upi_launch_${token}`;

// Same payment link, different "front doors": the generic one lets the phone offer every installed UPI app,
// the others open one specific app directly.
const APPS = [
  { id: 'gpay', label: 'Google Pay', scheme: 'tez://upi/pay?' },
  { id: 'phonepe', label: 'PhonePe', scheme: 'phonepe://pay?' },
  { id: 'paytm', label: 'Paytm', scheme: 'paytmmp://pay?' },
];

const read = (key) => {
  try {
    return Number(sessionStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
};
const write = (key, value) => {
  try {
    if (value) sessionStorage.setItem(key, String(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* storage can be blocked; the "I've paid" button still works */
  }
};

const isTouchDevice = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

// iPhones do not offer a system "choose a UPI app" list for upi:// links, so there the app-specific buttons are the main way in.
const isIos = () =>
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/**
 * Pay through a UPI app (Google Pay, PhonePe, Paytm ...). The server hands us the payment link with the exact amount.
 * A plain UPI link cannot report back whether the payment worked, so when the diner returns to this page we ask
 * "Did your payment go through?"; their answer is a *claim* that the restaurant staff confirm. It never marks the
 * order paid by itself.
 */
export default function UpiPayment({ order, onRefresh }) {
  const toast = useToast();
  const refId = useId();
  const refErrorId = useId();
  const { upi } = order;
  const claim = order.payment_claim;
  const touch = isTouchDevice();
  const ios = touch && isIos();
  const [asking, setAsking] = useState(false);
  const [reference, setReference] = useState('');
  const [refError, setRefError] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(null);
  const [qr, setQr] = useState('');
  // hasVpa: there is a payment link to turn into a QR code. buttons: also show the Google Pay / PhonePe / Paytm buttons, which the
  // restaurant turns on only for a business UPI ID (apps refuse such links for a personal one, so by default diners pay by hand).
  const hasVpa = Boolean(upi.vpa && upi.query);
  const buttons = Boolean(upi.pay_buttons && hasVpa);
  const [manualOpen, setManualOpen] = useState(!buttons && (touch || !hasVpa));

  const genericLink = hasVpa ? `upi://pay?${upi.query}` : null;

  // When the diner comes back from the UPI app, ask whether it worked.
  useEffect(() => {
    const key = launchKey(order.token);
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const at = read(key);
      if (at && Date.now() - at > 2500 && Date.now() - at < 30 * 60_000) setAsking(true);
    };
    check();
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('pageshow', check);
    };
  }, [order.token]);

  // A QR code of the payment link: shown up front on a computer (scan it with a phone), and tucked under
  // "Pay manually" on a phone (screenshot it, then use "Upload QR" in the UPI app).
  useEffect(() => {
    if (!genericLink) return undefined;
    let cancelled = false;
    import('qrcode')
      .then((m) => (m.default ?? m).toDataURL(genericLink, { width: 320, margin: 1, errorCorrectionLevel: 'M' }))
      .then((url) => !cancelled && setQr(url))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [genericLink]);

  const markLaunched = () => write(launchKey(order.token), Date.now());

  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.show(`${what}: ${text}`);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (sending) return;
    const value = reference.trim();
    if (value && !REFERENCE_RE.test(value)) {
      setRefError('The reference is 6-30 letters or digits. You can also leave it empty.');
      return;
    }
    setSending(true);
    setMessage(null);
    try {
      await claimUpiPayment(order.token, value);
      write(launchKey(order.token), 0);
      setAsking(false);
      toast.success('Thanks! The restaurant will confirm your payment shortly.');
      onRefresh();
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, "We couldn't send that. Please try again, or show your payment to a member of staff.") });
    } finally {
      setSending(false);
    }
  };

  const notYet = () => {
    write(launchKey(order.token), 0);
    setAsking(false);
    setRefError('');
    setReference('');
  };

  if (claim) {
    return (
      <div className="mt-4 rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-200" role="status">
        <p className="flex items-center gap-2 font-extrabold text-amber-950">
          <ClockIcon className="size-5" /> Payment submitted
        </p>
        <p className="mt-1 text-sm text-amber-950">
          Waiting for the restaurant to confirm {formatMoney(order.total)}
          {claim.reference ? ` (reference ${claim.reference})` : ''}. This page updates by itself. If it takes long, show this screen to a member of staff.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-2xl bg-page p-3 ring-1 ring-line">
      <p className="flex items-center gap-2 font-extrabold text-ink">
        <PhoneIcon className="size-5 text-brand-700" /> {buttons ? 'Pay with a UPI app' : 'Pay by UPI'}
      </p>
      <p className="mt-0.5 text-sm text-ink-soft">
        {buttons ? (
          <>
            Opens your UPI app with <strong className="text-ink">{formatMoney(upi.amount)}</strong> already filled in. Pay there, then come back to this page.
          </>
        ) : (
          <>
            Send <strong className="text-ink">{formatMoney(upi.amount)}</strong> to the restaurant&apos;s UPI ID from any UPI app (Google Pay, PhonePe, Paytm ...), then come back to this page.
          </>
        )}
      </p>

      {touch && buttons ? (
        <div className="mt-3 space-y-2">
          {ios ? (
            // iPhone: open the chosen app directly.
            APPS.map((app) => (
              <a key={app.id} href={`${app.scheme}${upi.query}`} onClick={markLaunched} className={buttonClass({ block: true })}>
                Pay {formatMoney(upi.amount)} with {app.label}
              </a>
            ))
          ) : (
            <>
              <a href={genericLink} onClick={markLaunched} className={buttonClass({ block: true })}>
                Pay {formatMoney(upi.amount)} with UPI app
              </a>
              <div className="grid grid-cols-3 gap-2">
                {APPS.map((app) => (
                  <a
                    key={app.id}
                    href={`${app.scheme}${upi.query}`}
                    onClick={markLaunched}
                    className={buttonClass({ variant: 'secondary', className: 'min-h-11 px-2 text-sm' })}
                  >
                    {app.label}
                  </a>
                ))}
              </div>
            </>
          )}
        </div>
      ) : hasVpa ? (
        <div className={`mt-3 flex gap-4 ${touch ? 'flex-col items-center text-center' : 'items-center'}`}>
          <div className={`grid shrink-0 place-items-center rounded-2xl bg-white p-2 ring-1 ring-line ${touch ? 'size-40' : 'size-36'}`}>
            {qr ? <img src={qr} alt={`UPI QR code to pay ${formatMoney(upi.amount)}`} className="size-full" /> : <span className="text-xs text-ink-soft">Loading QR…</span>}
          </div>
          <p className="min-w-0 text-sm text-ink-soft">
            {touch ? (
              <>
                <strong className="text-ink">Scan this QR code</strong> with Google Pay, PhonePe, Paytm or any UPI app on another phone. Paying from this phone? Take a screenshot, then use &ldquo;Scan from gallery&rdquo; in your UPI app.
              </>
            ) : (
              'On a computer? Scan this QR code with Google Pay, PhonePe, Paytm or any UPI app on your phone. Or open this page on your phone.'
            )}
          </p>
        </div>
      ) : null}

      {!buttons && (
      <details
        open={manualOpen}
        onToggle={(e) => setManualOpen(e.currentTarget.open)}
        className="mt-3 rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-line"
      >
        <summary className="cursor-pointer font-semibold text-ink">How to pay</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-soft">
          <li>
            Open Google Pay, PhonePe or any UPI app and choose{' '}
            <strong className="text-ink">Pay UPI ID</strong>.
          </li>
          <li>
            Enter the UPI ID below and exactly{' '}
            <strong className="text-ink">{formatMoney(upi.amount)}</strong>.
          </li>
          <li>Come back here and tap &ldquo;I&apos;ve already paid&rdquo;.</li>
        </ol>
        <dl className="mt-3 space-y-2 border-t border-line pt-3">
          {upi.vpa && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-soft">UPI ID</dt>
              <dd className="flex min-w-0 items-center gap-1.5 font-semibold text-ink">
                <span className="truncate">{upi.vpa}</span>
                <button type="button" onClick={() => copy(upi.vpa, 'UPI ID')} aria-label="Copy UPI ID" className="grid size-9 shrink-0 place-items-center rounded-lg text-brand-700 hover:bg-brand-50">
                  <CopyIcon className="size-4" />
                </button>
              </dd>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <dt className="text-ink-soft">Amount</dt>
            <dd className="flex items-center gap-1.5 font-semibold tabular-nums text-ink">
              {formatMoney(upi.amount)}
              <button type="button" onClick={() => copy(upi.amount.toFixed(2), 'Amount')} aria-label="Copy amount" className="grid size-9 shrink-0 place-items-center rounded-lg text-brand-700 hover:bg-brand-50">
                <CopyIcon className="size-4" />
              </button>
            </dd>
          </div>
        </dl>
      </details>
      )}

      {asking ? (
        <form onSubmit={submit} noValidate className="mt-3 rounded-2xl bg-white p-3 ring-2 ring-brand-300" aria-label="Confirm your payment">
          <p className="font-extrabold text-ink">Did your payment of {formatMoney(upi.amount)} go through?</p>
          <label htmlFor={refId} className="mt-2 block text-sm font-semibold text-ink">
            UPI reference number <span className="font-normal text-ink-soft">(optional, helps the restaurant)</span>
          </label>
          <input
            id={refId}
            value={reference}
            onChange={(e) => {
              setReference(e.target.value);
              setRefError('');
            }}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="e.g. 412345678901"
            aria-invalid={refError ? true : undefined}
            aria-describedby={refError ? refErrorId : undefined}
            className="mt-1 block min-h-12 w-full rounded-xl border-0 bg-page px-3 text-ink ring-1 ring-inset ring-line"
          />
          {refError && (
            <p id={refErrorId} role="alert" className="mt-1 text-sm font-medium text-rose-800">
              {refError}
            </p>
          )}
          {message && (
            <Alert tone={message.tone} className="mt-2">
              {message.text}
            </Alert>
          )}
          <div className="mt-3 grid grid-cols-[3fr_2fr] gap-2">
            <Button type="submit" loading={sending}>
              <CheckIcon className="size-5" /> Yes, I&apos;ve paid
            </Button>
            <Button variant="secondary" onClick={notYet} disabled={sending}>
              Not yet
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="secondary" block className="mt-3" onClick={() => setAsking(true)}>
          I&apos;ve already paid
        </Button>
      )}
    </div>
  );
}

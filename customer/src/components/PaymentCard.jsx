import { useEffect, useRef, useState } from 'react';
import Alert from './Alert';
import { Button } from './Button';
import { CardIcon, CashIcon, CheckIcon, ClockIcon } from './Icons';
import { useToast } from './Toast';
import { ApiError, errorMessage, startGatewayPayment, startRazorpay, startRazorpayQr, verifyGatewayPayment, verifyRazorpay, verifyRazorpayQr } from '../lib/api';
import { formatMoney } from '../lib/money';
import { loadRazorpay, PaymentScriptError } from '../lib/razorpay';
import { getItem, removeItem, setItem } from '../lib/storage';
import { brandColor } from '../lib/theme';
import { formatTime } from '../lib/time';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retriable = (err) => err instanceof ApiError && (err.status === 0 || err.status >= 500 || err.status === 429);

// Old orders can carry a way of paying that is no longer offered (UPI, Cashfree, Paytm).
const methodLabel = { cash: 'Cash at counter', razorpay: 'Online', phonepe: 'Online', upi: 'UPI', cashfree: 'Online', paytm: 'Online' };

/** Sends the browser to PhonePe's own payment page. Only https addresses are followed. */
function goToGateway(client) {
  let url = null;
  try {
    url = new URL(client?.url);
  } catch {
    /* not an address: reported below */
  }
  const safe = url?.protocol === 'https:' || (import.meta.env.DEV && url?.protocol === 'http:'); // plain http only on the local dev server
  if (client?.type === 'redirect' && safe) {
    window.location.assign(url.href);
    return;
  }
  throw new ApiError({ status: 0, code: 'BAD_PAYMENT_PAGE', message: 'The payment page could not be opened. Please try again or pay another way.' });
}

// PhonePe takes the diner to its own page and brings them back here: remember (on this device) that they left to pay, so coming
// back asks the server whether the money arrived.
const payKey = (token) => `mezmitra_pay_${token}`;
const payAttempted = (token) => {
  const at = Number(getItem(payKey(token)));
  return at > 0 && Date.now() - at < 60 * 60_000;
};

/**
 * Payment status of an order.
 *  - paid: "Paid" + method.
 *  - unpaid + online payment available: "Pay online" (Razorpay Checkout or PhonePe, whichever the restaurant uses), with the counter as the alternative.
 *  - otherwise: "Please pay at the counter"; the page polls so the counter payment shows up by itself.
 * `onPaid(order)` receives the verified order; `onRefresh()` re-reads the order from the server.
 */
export default function PaymentCard({ order, onPaid, onRefresh }) {
  const toast = useToast();
  const [phase, setPhase] = useState('idle'); // idle | starting | checkout | verifying | confirm_failed | pending
  const [message, setMessage] = useState(null); // { tone, text }
  const busy = useRef(false);
  const [qr, setQr] = useState(null); // { image_url } while the "scan to pay" QR is on screen
  const [qrLoading, setQrLoading] = useState(false);
  const unverified = useRef(null); // Razorpay response we still have to confirm with the server

  const redirectGateway = order.payment_options?.phonepe === true; // otherwise online payment means Razorpay, which opens in a window
  const online = redirectGateway || order.payment_options?.razorpay === true;
  const unpaid = order.payment_status !== 'paid';
  const cancelled = order.status === 'cancelled';

  // Warm up the Checkout script so tapping "Pay online" opens it straight away. Failures surface on tap.
  useEffect(() => {
    if (online && unpaid && !cancelled && !redirectGateway) loadRazorpay().catch(() => {});
  }, [online, redirectGateway, unpaid, cancelled]);

  // While the scan-to-pay QR is on screen, ask the server every few seconds whether the money arrived (it asks Razorpay). Stops after
  // 20 minutes, and while the page is in the background.
  useEffect(() => {
    if (!qr || !unpaid || cancelled) return undefined;
    let stopped = false;
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || Date.now() - startedAt > 20 * 60_000) return;
      try {
        const updated = await verifyRazorpayQr(order.token);
        if (!stopped && updated.payment_status === 'paid') {
          setQr(null);
          onPaid(updated);
          toast.success('Payment received. Thank you!');
        }
      } catch {
        /* try again on the next tick */
      }
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [qr, unpaid, cancelled, order.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // PhonePe: when the diner comes back from its page (or from a UPI app, or reopens a closed tab), ask the server whether the money
  // arrived. The server asks PhonePe, so this can never mark an order paid by itself.
  useEffect(() => {
    if (!(redirectGateway && unpaid && !cancelled)) return undefined;
    let stopped = false;
    const recheck = async () => {
      if (document.visibilityState !== 'visible' || busy.current || !payAttempted(order.token)) return;
      try {
        const updated = await verifyGatewayPayment(order.token, 'phonepe');
        if (!stopped && updated.payment_status === 'paid') {
          removeItem(payKey(order.token));
          onPaid(updated);
          toast.success('Payment received. Thank you!');
        } else if (!stopped) {
          // Back from PhonePe's page without a confirmed payment: say so, and let the diner check again or pay again.
          setPhase('pending');
          setMessage({
            tone: 'info',
            text: "We haven't received your payment yet. If you already paid, give your bank a moment and tap “Check payment”. Otherwise you can pay again.",
          });
        }
      } catch {
        /* the next visit tries again */
      }
    };
    recheck();
    document.addEventListener('visibilitychange', recheck);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [redirectGateway, unpaid, cancelled, order.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coming back to this page with the browser's Back button restores it as it was left ("opening the payment page"): reset it.
  useEffect(() => {
    const restored = (event) => {
      if (!event.persisted) return;
      busy.current = false;
      setPhase('idle');
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);

  if (order.payment_status === 'refunded') {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-page text-ink-soft">
            <CashIcon className="size-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-extrabold text-ink">Refunded</h2>
            <p className="text-sm text-ink-soft">Your payment was returned to your account. It can take a few days to show up.</p>
          </div>
          <p className="text-lg font-extrabold tabular-nums text-ink">{formatMoney(order.total)}</p>
        </div>
      </Card>
    );
  }

  if (!unpaid) {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-emerald-100 text-emerald-800">
            <CheckIcon className="size-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-extrabold text-ink">Paid</h2>
            <p className="text-sm text-ink-soft">
              {order.payment_method ? methodLabel[order.payment_method] ?? 'Payment received' : 'Payment received'}
              {order.paid_at ? ` · ${formatTime(order.paid_at)}` : ''}
            </p>
          </div>
          <p className="text-lg font-extrabold tabular-nums text-ink">{formatMoney(order.total)}</p>
        </div>
      </Card>
    );
  }

  if (cancelled) {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-page text-ink-soft">
            <CashIcon className="size-6" />
          </span>
          <div>
            <h2 className="text-lg font-extrabold text-ink">Nothing to pay</h2>
            <p className="text-sm text-ink-soft">This order was cancelled, so you have not been charged.</p>
          </div>
        </div>
      </Card>
    );
  }

  const confirm = async (response) => {
    unverified.current = response;
    setPhase('verifying');
    setMessage(null);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const updated = await verifyRazorpay(order.token, unverified.current);
        unverified.current = null;
        busy.current = false;
        setPhase('idle');
        onPaid(updated);
        toast.success('Payment received. Thank you!');
        return;
      } catch (err) {
        if (!retriable(err)) {
          // The server rejected it (e.g. signature mismatch). Retrying will not help; its message tells the diner what to do.
          unverified.current = null;
          busy.current = false;
          setPhase('idle');
          setMessage({ tone: 'error', text: errorMessage(err, 'We could not confirm your payment. If money was deducted, please show this screen to a member of staff.') });
          onRefresh();
          return;
        }
        if (attempt < 2) await sleep(1500 * (attempt + 1));
      }
    }
    busy.current = false;
    setPhase('confirm_failed');
    setMessage({
      tone: 'error',
      text: "We couldn't confirm your payment yet. Please don't pay again - tap “Retry confirmation”. If it keeps failing, show this screen to a member of staff.",
    });
  };

  // PhonePe: ask the server whether the money arrived (the diner says they paid).
  const checkGateway = async () => {
    busy.current = true;
    setPhase('verifying');
    setMessage(null);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const updated = await verifyGatewayPayment(order.token, 'phonepe');
        if (updated.payment_status === 'paid') {
          removeItem(payKey(order.token));
          busy.current = false;
          setPhase('idle');
          onPaid(updated);
          toast.success('Payment received. Thank you!');
          return;
        }
        break; // PhonePe has not received the money (yet)
      } catch (err) {
        if (!retriable(err)) {
          busy.current = false;
          setPhase('idle');
          setMessage({ tone: 'error', text: errorMessage(err, 'We could not confirm your payment. If money was deducted, please show this screen to a member of staff.') });
          onRefresh();
          return;
        }
        if (attempt < 2) await sleep(1500 * (attempt + 1));
      }
    }
    busy.current = false;
    setPhase('pending');
    setMessage({
      tone: 'info',
      text: "We haven't received your payment yet. If you already paid, give your bank a moment and tap “Check payment”. Otherwise you can pay again.",
    });
  };

  // PhonePe: the server opens the payment, then this browser leaves for PhonePe's page and comes back to this order page.
  const payViaGatewayPage = async () => {
    const session = await startGatewayPayment(order.token, 'phonepe');
    setItem(payKey(order.token), String(Date.now()));
    setPhase('checkout');
    goToGateway(session.client);
  };

  const showQr = async () => {
    if (qrLoading) return;
    setQrLoading(true);
    setMessage(null);
    try {
      setQr(await startRazorpayQr(order.token));
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'We could not make the QR code. Please tap “Pay online” instead.') });
      if (err instanceof ApiError && ['ALREADY_PAID', 'ORDER_CANCELLED'].includes(err.code)) onRefresh();
    } finally {
      setQrLoading(false);
    }
  };

  const payOnline = async () => {
    if (busy.current) return;
    busy.current = true;
    setMessage(null);
    setPhase('starting');
    try {
      if (redirectGateway) {
        await payViaGatewayPage();
        return;
      }
      const session = await startRazorpay(order.token);
      const Razorpay = await loadRazorpay();
      let completed = false;
      let failure = null;
      const checkout = new Razorpay({
        key: session.key_id,
        order_id: session.razorpay_order_id,
        amount: session.amount_paise,
        currency: session.currency,
        name: session.vendor_name,
        description: `Table ${order.table_number}`,
        theme: { color: brandColor() },
        handler: (response) => {
          completed = true;
          confirm(response);
        },
        modal: {
          ondismiss: () => {
            if (completed) return;
            busy.current = false;
            setPhase('idle');
            setMessage(
              failure
                ? { tone: 'error', text: `${failure} You can try again${counterOk ? ', or pay at the counter' : ' or ask a member of staff'}.` }
                : { tone: 'info', text: 'Payment cancelled - nothing was charged. You can try again whenever you like.' },
            );
          },
        },
      });
      checkout.on?.('payment.failed', (res) => {
        failure = res?.error?.description || 'The payment did not go through.';
      });
      setPhase('checkout');
      checkout.open();
    } catch (err) {
      busy.current = false;
      setPhase('idle');
      if (err instanceof PaymentScriptError) {
        setMessage({ tone: 'error', text: err.message });
        return;
      }
      setMessage({ tone: 'error', text: errorMessage(err, `We couldn't start the payment. Please try again${counterOk ? ' or pay at the counter' : ', or ask a member of staff'}.`) });
      if (err instanceof ApiError && ['ALREADY_PAID', 'ORDER_CANCELLED'].includes(err.code)) onRefresh();
    }
  };

  const working = phase === 'starting' || phase === 'checkout' || phase === 'verifying';
  // The counter is only mentioned when the restaurant really takes payment there.
  const counterOk = order.payment_options?.cash !== false;

  return (
    <Card>
      <div className="flex items-center gap-3">
        <span className={`grid size-11 place-items-center rounded-2xl ${online ? 'bg-tint-strong text-link' : 'bg-amber-100 text-amber-900'}`}>
          {online ? <CardIcon className="size-6" /> : <CashIcon className="size-6" />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-extrabold text-ink">{online ? 'Payment due' : 'Please pay at the counter'}</h2>
          <p className="text-sm text-ink-soft">
            {online
              ? counterOk
                ? 'Pay with your phone, or pay at the counter - whichever you prefer.'
                : 'Pay with your phone. This page updates once your payment is confirmed.'
              : 'Show this screen at the counter when you are ready to pay.'}
          </p>
        </div>
        <p className="text-lg font-extrabold tabular-nums text-ink">{formatMoney(order.total)}</p>
      </div>

      {online && phase !== 'confirm_failed' && (
        <Button block className="mt-4" onClick={payOnline} loading={phase === 'starting'} disabled={working}>
          {phase === 'verifying' ? 'Confirming payment…' : phase === 'checkout' ? (redirectGateway ? 'Opening payment page…' : 'Payment window open') : `Pay online - ${formatMoney(order.total)}`}
        </Button>
      )}

      {online && !redirectGateway && phase !== 'confirm_failed' && (
        <div className="mt-3">
          {!qr ? (
            <button
              type="button"
              onClick={showQr}
              disabled={qrLoading || working}
              className="w-full rounded-2xl px-4 py-2.5 text-center text-sm font-bold text-link transition-colors hover:bg-tint disabled:opacity-60"
            >
              {qrLoading ? 'Making QR code…' : 'Or scan a QR code to pay'}
            </button>
          ) : (
            <div className="rounded-2xl bg-card p-4 text-center ring-1 ring-inset ring-line">
              <img src={qr.image_url} alt={`QR code to pay ${formatMoney(order.total)}`} className="mx-auto size-56 max-w-full" />
              <p className="mt-2 text-sm font-semibold text-ink">Scan with Google Pay, PhonePe, Paytm or any UPI app</p>
              <p role="status" className="mt-1 text-sm text-ink-soft">
                The amount is filled in. This page updates by itself once your payment is received.
              </p>
              <button type="button" onClick={() => setQr(null)} className="mt-2 text-sm font-bold text-link underline underline-offset-2">
                Hide QR code
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'pending' && (
        <Button block variant="secondary" className="mt-2" onClick={checkGateway}>
          Check payment
        </Button>
      )}

      {phase === 'confirm_failed' && (
        <Button
          block
          className="mt-4"
          onClick={() => confirm(unverified.current)}
          disabled={!unverified.current}
        >
          Retry confirmation
        </Button>
      )}

      {phase === 'verifying' && (
        <p role="status" className="mt-3 text-sm font-medium text-ink-soft">
          Confirming your payment with the bank - please keep this page open.
        </p>
      )}

      {message && (
        <Alert tone={message.tone} className="mt-3">
          {message.text}
        </Alert>
      )}

      <p className="mt-4 flex items-start gap-2 text-sm text-ink-soft">
        <ClockIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          {online
            ? counterOk
              ? 'If you pay at the counter, this page updates by itself once the staff record your payment.'
              : 'This page updates by itself once your payment is received.'
            : 'This page updates automatically once the staff record your payment.'}
        </span>
      </p>
    </Card>
  );
}

function Card({ children }) {
  return <section aria-label="Payment" className="surface p-4">{children}</section>;
}

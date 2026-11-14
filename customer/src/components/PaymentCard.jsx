import { useEffect, useRef, useState } from 'react';
import Alert from './Alert';
import { Button } from './Button';
import { CardIcon, CashIcon, CheckIcon, ClockIcon } from './Icons';
import { useToast } from './Toast';
import UpiPayment from './UpiPayment';
import { ApiError, errorMessage, startCashfree, startRazorpay, startRazorpayQr, verifyCashfree, verifyRazorpay, verifyRazorpayQr } from '../lib/api';
import { loadCashfree } from '../lib/cashfree';
import { formatMoney } from '../lib/money';
import { loadRazorpay, PaymentScriptError } from '../lib/razorpay';
import { getItem, removeItem, setItem } from '../lib/storage';
import { brandColor } from '../lib/theme';
import { formatTime } from '../lib/time';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retriable = (err) => err instanceof ApiError && (err.status === 0 || err.status >= 500 || err.status === 429);

const methodLabel = { cash: 'Cash at counter', razorpay: 'Online', cashfree: 'Online', upi: 'UPI' };

// Cashfree: remember (on this device) that the diner opened the payment window, so coming back to the page after a UPI app or a
// closed tab asks the server whether the money arrived.
const cfKey = (token) => `mezmitra_cf_${token}`;
const cfAttempted = (token) => {
  const at = Number(getItem(cfKey(token)));
  return at > 0 && Date.now() - at < 60 * 60_000;
};

/**
 * Payment status of an order.
 *  - paid: "Paid" + method.
 *  - unpaid + online payment available: "Pay online" (Razorpay Checkout or Cashfree, whichever the restaurant uses), with the counter as the alternative.
 *  - otherwise: "Please pay at the counter"; the page polls so the counter payment shows up by itself.
 * `onPaid(order)` receives the verified order; `onRefresh()` re-reads the order from the server.
 */
export default function PaymentCard({ order, onPaid, onRefresh }) {
  const toast = useToast();
  const [phase, setPhase] = useState('idle'); // idle | starting | checkout | verifying | confirm_failed | cf_pending
  const [message, setMessage] = useState(null); // { tone, text }
  const busy = useRef(false);
  const [qr, setQr] = useState(null); // { image_url } while the "scan to pay" QR is on screen
  const [qrLoading, setQrLoading] = useState(false);
  const unverified = useRef(null); // Razorpay response we still have to confirm with the server

  const provider = order.payment_options?.cashfree === true ? 'cashfree' : 'razorpay';
  const online = order.payment_options?.razorpay === true || order.payment_options?.cashfree === true;
  const unpaid = order.payment_status !== 'paid';
  const cancelled = order.status === 'cancelled';

  // Warm up the Checkout script so tapping "Pay online" opens it straight away. Failures surface on tap.
  useEffect(() => {
    if (online && unpaid && !cancelled) (provider === 'cashfree' ? loadCashfree : loadRazorpay)().catch(() => {});
  }, [online, provider, unpaid, cancelled]);

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

  // Cashfree: the diner may have been sent to a UPI app (or closed the tab) in the middle of paying. When they come back, ask the
  // server whether the money arrived. The server asks Cashfree, so this can never mark an order paid by itself.
  useEffect(() => {
    if (!(online && provider === 'cashfree' && unpaid && !cancelled)) return undefined;
    let stopped = false;
    const recheck = async () => {
      if (document.visibilityState !== 'visible' || busy.current || !cfAttempted(order.token)) return;
      try {
        const updated = await verifyCashfree(order.token);
        if (!stopped && updated.payment_status === 'paid') {
          removeItem(cfKey(order.token));
          onPaid(updated);
          toast.success('Payment received. Thank you!');
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
  }, [online, provider, unpaid, cancelled, order.token]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Cashfree: ask the server whether Cashfree has the money (the window has closed, or the diner says they paid).
  const checkCashfree = async (failure) => {
    busy.current = true;
    setPhase('verifying');
    setMessage(null);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const updated = await verifyCashfree(order.token);
        if (updated.payment_status === 'paid') {
          removeItem(cfKey(order.token));
          busy.current = false;
          setPhase('idle');
          onPaid(updated);
          toast.success('Payment received. Thank you!');
          return;
        }
        break; // Cashfree has not received the money (yet)
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
    setPhase('cf_pending');
    setMessage({
      tone: failure ? 'error' : 'info',
      text: failure
        ? `The payment did not go through. If money was deducted, tap “Check payment” in a minute. Otherwise you can try again${counterOk ? ', or pay at the counter' : ' or ask a member of staff'}.`
        : "We haven't received your payment yet. If you already paid, give your bank a moment and tap “Check payment”. Otherwise you can pay again.",
    });
  };

  const payWithCashfree = async () => {
    const session = await startCashfree(order.token);
    const Cashfree = await loadCashfree();
    const cashfree = Cashfree({ mode: session.mode });
    setItem(cfKey(order.token), String(Date.now()));
    setPhase('checkout');
    let result = null;
    try {
      result = await cashfree.checkout({ paymentSessionId: session.payment_session_id, redirectTarget: '_modal' });
    } catch {
      result = { error: { message: 'The payment window closed unexpectedly.' } };
    }
    // The window is closed: paid, failed or dismissed. Only the server (asking Cashfree) knows which.
    await checkCashfree(result?.error?.message ?? null);
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
      if (provider === 'cashfree') {
        await payWithCashfree();
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
  const upiAvailable = Boolean(order.upi);
  const digital = online || upiAvailable;
  // The counter is only mentioned when the restaurant really takes payment there.
  const counterOk = order.payment_options?.cash !== false;

  return (
    <Card>
      <div className="flex items-center gap-3">
        <span className={`grid size-11 place-items-center rounded-2xl ${digital ? 'bg-brand-100 text-brand-700' : 'bg-amber-100 text-amber-900'}`}>
          {digital ? <CardIcon className="size-6" /> : <CashIcon className="size-6" />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-extrabold text-ink">{digital ? 'Payment due' : 'Please pay at the counter'}</h2>
          <p className="text-sm text-ink-soft">
            {digital
              ? counterOk
                ? 'Pay with your phone, or pay at the counter - whichever you prefer.'
                : 'Pay with your phone. This page updates once your payment is confirmed.'
              : 'Show this screen at the counter when you are ready to pay.'}
          </p>
        </div>
        <p className="text-lg font-extrabold tabular-nums text-ink">{formatMoney(order.total)}</p>
      </div>

      {upiAvailable && <UpiPayment order={order} onRefresh={onRefresh} />}

      {online && phase !== 'confirm_failed' && (
        <Button block className="mt-4" onClick={payOnline} loading={phase === 'starting'} disabled={working}>
          {phase === 'verifying' ? 'Confirming payment…' : phase === 'checkout' ? 'Payment window open' : `Pay online - ${formatMoney(order.total)}`}
        </Button>
      )}

      {online && provider === 'razorpay' && phase !== 'confirm_failed' && (
        <div className="mt-3">
          {!qr ? (
            <button
              type="button"
              onClick={showQr}
              disabled={qrLoading || working}
              className="w-full rounded-2xl px-4 py-2.5 text-center text-sm font-bold text-brand-700 transition-colors hover:bg-brand-50 disabled:opacity-60"
            >
              {qrLoading ? 'Making QR code…' : 'Or scan a QR code to pay'}
            </button>
          ) : (
            <div className="rounded-2xl bg-white p-4 text-center ring-1 ring-inset ring-line">
              <img src={qr.image_url} alt={`QR code to pay ${formatMoney(order.total)}`} className="mx-auto size-56 max-w-full" />
              <p className="mt-2 text-sm font-semibold text-ink">Scan with Google Pay, PhonePe, Paytm or any UPI app</p>
              <p role="status" className="mt-1 text-sm text-ink-soft">
                The amount is filled in. This page updates by itself once your payment is received.
              </p>
              <button type="button" onClick={() => setQr(null)} className="mt-2 text-sm font-bold text-brand-700 underline underline-offset-2">
                Hide QR code
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'cf_pending' && (
        <Button block variant="secondary" className="mt-2" onClick={() => checkCashfree(null)}>
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
          {digital
            ? counterOk
              ? 'If you pay at the counter, this page updates by itself once the staff record your payment.'
              : 'This page updates by itself once the restaurant confirms your payment.'
            : 'This page updates automatically once the staff record your payment.'}
        </span>
      </p>
    </Card>
  );
}

function Card({ children }) {
  return <section aria-label="Payment" className="surface p-4">{children}</section>;
}

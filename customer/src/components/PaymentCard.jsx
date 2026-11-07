import { useEffect, useRef, useState } from 'react';
import Alert from './Alert';
import { Button } from './Button';
import { CardIcon, CashIcon, CheckIcon, ClockIcon } from './Icons';
import { useToast } from './Toast';
import UpiPayment from './UpiPayment';
import { ApiError, errorMessage, startRazorpay, verifyRazorpay } from '../lib/api';
import { formatMoney } from '../lib/money';
import { loadRazorpay, PaymentScriptError } from '../lib/razorpay';
import { brandColor } from '../lib/theme';
import { formatTime } from '../lib/time';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retriable = (err) => err instanceof ApiError && (err.status === 0 || err.status >= 500 || err.status === 429);

const methodLabel = { cash: 'Cash at counter', razorpay: 'Online', upi: 'UPI' };

/**
 * Payment status of an order.
 *  - paid: "Paid" + method.
 *  - unpaid + online payment available: "Pay online" (Razorpay Checkout), with the counter as the alternative.
 *  - otherwise: "Please pay at the counter"; the page polls so the counter payment shows up by itself.
 * `onPaid(order)` receives the verified order; `onRefresh()` re-reads the order from the server.
 */
export default function PaymentCard({ order, onPaid, onRefresh }) {
  const toast = useToast();
  const [phase, setPhase] = useState('idle'); // idle | starting | checkout | verifying | confirm_failed
  const [message, setMessage] = useState(null); // { tone, text }
  const busy = useRef(false);
  const unverified = useRef(null); // Razorpay response we still have to confirm with the server

  const online = order.payment_options?.razorpay === true;
  const unpaid = order.payment_status !== 'paid';
  const cancelled = order.status === 'cancelled';

  // Warm up the Checkout script so tapping "Pay online" opens it straight away. Failures surface on tap.
  useEffect(() => {
    if (online && unpaid && !cancelled) loadRazorpay().catch(() => {});
  }, [online, unpaid, cancelled]);

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

  const payOnline = async () => {
    if (busy.current) return;
    busy.current = true;
    setMessage(null);
    setPhase('starting');
    try {
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

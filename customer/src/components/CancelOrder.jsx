import { useId, useState } from 'react';
import Alert from './Alert';
import BottomSheet from './BottomSheet';
import { Button } from './Button';
import { useToast } from './Toast';
import { ApiError, cancelOrder, errorMessage } from '../lib/api';

/**
 * "Cancel order" for the diner, shown only while the server says they may (`order.can_cancel`: the kitchen has not accepted the order,
 * nothing is paid, no payment is under way). It asks first, because it cannot be undone. When the server refuses (the kitchen just
 * accepted it, say) the diner is told why and the page shows what is true now.
 */
export default function CancelOrder({ order, onCancelled, onRefresh }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const titleId = useId();

  const close = () => {
    if (busy) return;
    setOpen(false);
    setProblem(null);
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const updated = await cancelOrder(order.token);
      setOpen(false);
      onCancelled(updated);
      toast.success('Your order was cancelled.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CANNOT_CANCEL') {
        // Something changed since this page last updated: show the reason, then the page as it is now.
        setProblem(err.message);
        onRefresh();
      } else {
        setProblem(errorMessage(err, 'We could not cancel your order. Please try again, or ask a member of staff.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="text-center">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-11 rounded-full px-5 text-[15px] font-bold text-rose-700 hover:bg-rose-50 active:bg-rose-100"
        >
          Cancel order
        </button>
      </div>

      {open && (
        <BottomSheet
          onClose={close}
          labelledBy={titleId}
          footer={
            <div className="space-y-2">
              <Button block onClick={close} disabled={busy}>
                Keep my order
              </Button>
              <Button block variant="danger" onClick={confirm} loading={busy}>
                Yes, cancel my order
              </Button>
            </div>
          }
        >
          <div className="space-y-3 px-5 pb-4 pt-6">
            <h2 id={titleId} className="display pr-12 text-[24px] font-extrabold leading-tight text-ink">
              Cancel this order?
            </h2>
            <p className="text-[15px] text-ink-soft">
              The kitchen has not started on it yet, so nothing will be charged. This can&rsquo;t be undone. To order again, you will need to place a new
              order.
            </p>
            {problem && <Alert>{problem}</Alert>}
          </div>
        </BottomSheet>
      )}
    </>
  );
}

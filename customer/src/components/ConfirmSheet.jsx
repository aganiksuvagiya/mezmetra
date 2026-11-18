import { useId } from 'react';
import BottomSheet from './BottomSheet';
import { Button } from './Button';

/**
 * "Are you sure?" for something the diner cannot easily get back (taking a dish out of the cart). Same look as the cancel-order sheet:
 * the safe choice is the big primary button, the destructive one sits under it. Esc or a tap outside is the same as "keep it".
 */
export default function ConfirmSheet({ title, message, confirmLabel, cancelLabel = 'Keep it', onConfirm, onCancel }) {
  const titleId = useId();
  return (
    <BottomSheet
      onClose={onCancel}
      labelledBy={titleId}
      footer={
        <div className="space-y-2">
          <Button block onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button block variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 px-5 pb-4 pt-6">
        <h2 id={titleId} className="display pr-12 text-[24px] font-extrabold leading-tight text-ink">
          {title}
        </h2>
        {message && <p className="text-[15px] text-ink-soft">{message}</p>}
      </div>
    </BottomSheet>
  );
}

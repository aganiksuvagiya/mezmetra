import { useState } from 'react';
import { useAction } from '../lib/hooks.js';
import { Button } from './Button.jsx';
import Modal from './Modal.jsx';
import { Alert } from './EmptyState.jsx';

/**
 * Styled replacement for window.confirm. `onConfirm` may be async: while it runs both buttons are disabled; if it
 * throws, the error message is shown inside the dialog (for example a 409 "category still has items") and the dialog
 * stays open. When it resolves the caller should close the dialog (set `open` false).
 */
export default function ConfirmDialog({ open, ...props }) {
  if (!open) return null;
  return <ConfirmInner {...props} />;
}

function ConfirmInner({ title, message, confirmLabel = 'Delete', cancelLabel = 'Cancel', tone = 'danger', onConfirm, onCancel }) {
  const [run, busy] = useAction();
  const [error, setError] = useState(null);

  const confirm = () =>
    run(async () => {
      setError(null);
      try {
        await onConfirm();
      } catch (e) {
        setError(e?.message || 'Something went wrong. Please try again.');
      }
    });

  return (
    <Modal
      role="alertdialog"
      size="sm"
      title={title}
      description={message}
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-autofocus>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={confirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}

import { useState } from 'react';
import { Button } from '../../components/Button.jsx';
import { Alert } from '../../components/EmptyState.jsx';
import { Input } from '../../components/Field.jsx';
import Modal from '../../components/Modal.jsx';
import { api } from '../../lib/api.js';
import { useAction } from '../../lib/hooks.js';

/** Asks for an optional reason (shown to the restaurant when it tries to sign in), then suspends. */
export default function SuspendDialog({ restaurant, onClose, onDone }) {
  const [run, busy] = useAction();
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);

  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      setError(null);
      try {
        const updated = await api(`/api/platform/restaurants/${restaurant.id}`, { method: 'PATCH', body: { suspended: true, reason: reason.trim() || undefined } });
        onDone(updated);
      } catch (e) {
        setError(e.message || 'Something went wrong. Please try again.');
      }
    });
  };

  return (
    <Modal
      role="alertdialog"
      size="sm"
      title={`Suspend ${restaurant.name}?`}
      description="They won't be able to sign in, and their tables stop taking orders, until you reactivate them. Their data is kept."
      onClose={onClose}
      dismissible={!busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </Button>
          <Button type="submit" variant="danger" busy={busy}>
            Suspend
          </Button>
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      <Input
        label="Reason (optional)"
        hint="They see this when they try to sign in."
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={200}
        placeholder="e.g. unpaid invoice"
        autoComplete="off"
        wrapperClassName={error ? 'mt-3' : undefined}
      />
    </Modal>
  );
}

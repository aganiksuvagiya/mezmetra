import { useState } from 'react';
import { Button } from '../../components/Button.jsx';
import { Alert } from '../../components/EmptyState.jsx';
import { focusFirstInvalid, Input } from '../../components/Field.jsx';
import Modal from '../../components/Modal.jsx';
import { api, splitFieldErrors } from '../../lib/api.js';
import { useAction } from '../../lib/hooks.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Fix a restaurant's name or the email it signs in with (a typo, a new address). The password and everything else stay as they are. */
export default function EditRestaurantDialog({ restaurant, onClose, onDone }) {
  const [run, busy] = useAction();
  const [values, setValues] = useState({ name: restaurant.name, email: restaurant.email });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);

  const set = (field) => (e) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };
  const unchanged = values.name.trim() === restaurant.name && values.email.trim().toLowerCase() === restaurant.email.toLowerCase();

  const submit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const found = {};
    if (values.name.trim().length < 2) found.name = 'Enter the restaurant name (at least 2 characters).';
    if (!EMAIL_RE.test(values.email.trim())) found.email = 'Enter a valid email address.';
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length) {
      focusFirstInvalid(form);
      return;
    }
    run(async () => {
      try {
        const updated = await api(`/api/platform/restaurants/${restaurant.id}/profile`, { method: 'POST', body: { name: values.name.trim(), email: values.email.trim() } });
        onDone(updated);
      } catch (error) {
        const split = splitFieldErrors(error, ['name', 'email']);
        // "That email is taken / reserved" belongs under the email field, not in a banner.
        const emailIssue = error?.code === 'EMAIL_TAKEN' || error?.code === 'RESERVED_EMAIL';
        const fields = emailIssue ? { ...split.fields, email: error.message } : split.fields;
        setErrors(fields);
        setServerError(emailIssue ? null : split.formError);
        if (Object.keys(fields).length) focusFirstInvalid(form);
      }
    });
  };

  return (
    <Modal
      size="sm"
      title={`Edit ${restaurant.name}`}
      description="Fix the name or the email they sign in with. Their password and data stay as they are."
      onClose={onClose}
      dismissible={!busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={unchanged}>
            Save changes
          </Button>
        </>
      }
    >
      {serverError && <Alert className="mb-3">{serverError}</Alert>}
      <div className="space-y-3">
        <Input label="Restaurant name" name="name" value={values.name} onChange={set('name')} error={errors.name} required maxLength={100} autoComplete="off" data-autofocus />
        <Input
          label="Login email"
          name="email"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={values.email}
          onChange={set('email')}
          error={errors.email}
          hint="After you save, they sign in with this email (the same password). Tell them."
          required
          autoComplete="off"
        />
      </div>
    </Modal>
  );
}

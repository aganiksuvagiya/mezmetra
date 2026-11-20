import { useState } from 'react';
import { Button } from '../../components/Button.jsx';
import { Alert } from '../../components/EmptyState.jsx';
import { focusFirstInvalid, Input } from '../../components/Field.jsx';
import { CopyIcon } from '../../components/icons.jsx';
import Modal from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { api, splitFieldErrors } from '../../lib/api.js';
import { useAction } from '../../lib/hooks.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// No 0/O, 1/l/I: a first password gets read out or typed from a message, so it should not be ambiguous.
const PASSWORD_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random first password (12 characters), drawn without bias from the browser's secure random source. */
function generatePassword(length = 12) {
  const limit = 256 - (256 % PASSWORD_CHARS.length);
  const out = [];
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit && out.length < length) out.push(PASSWORD_CHARS[b % PASSWORD_CHARS.length]);
    }
  }
  return out.join('');
}

function Detail({ label, value, onCopy, mono }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <dt className="text-xs font-medium text-slate-500">{label}</dt>
        <dd className={`mt-0.5 break-all text-sm font-semibold text-slate-900 ${mono ? 'font-mono' : ''}`}>{value}</dd>
      </div>
      <Button variant="secondary" size="sm" icon={CopyIcon} onClick={() => onCopy(value, label)} aria-label={`Copy ${label}`}>
        Copy
      </Button>
    </div>
  );
}

/**
 * Adds a restaurant: the owner types its name and email and keeps (or changes) a first password. This is the only way an account comes
 * to exist: there is no public sign-up. When it is done the login is shown once, to hand over (the password is never shown again).
 */
export default function AddRestaurantDialog({ onClose, onCreated, onOpen }) {
  const toast = useToast();
  const [run, busy] = useAction();
  const [values, setValues] = useState(() => ({ name: '', email: '', password: generatePassword() }));
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [created, setCreated] = useState(null); // { id, name, email, password } once it is done

  const set = (field) => (e) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const submit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const found = {};
    if (values.name.trim().length < 2) found.name = 'Enter the restaurant name (at least 2 characters).';
    if (!EMAIL_RE.test(values.email.trim())) found.email = 'Enter a valid email address.';
    if (values.password.length < 8) found.password = 'Use at least 8 characters.';
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length) {
      focusFirstInvalid(form);
      return;
    }
    run(async () => {
      try {
        const body = { name: values.name.trim(), email: values.email.trim(), password: values.password };
        const made = await api('/api/platform/restaurants', { method: 'POST', body });
        setCreated({ id: made.id, name: made.name, email: made.email, password: values.password });
        onCreated(made);
      } catch (error) {
        const split = splitFieldErrors(error, ['name', 'email', 'password']);
        // "That email already has a restaurant" belongs under the email field, not in a banner.
        const taken = error?.code === 'EMAIL_TAKEN';
        const fields = taken ? { ...split.fields, email: error.message } : split.fields;
        setErrors(fields);
        setServerError(taken ? null : split.formError);
        if (Object.keys(fields).length) focusFirstInvalid(form);
      }
    });
  };

  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied.`);
    } catch {
      toast.error('Could not copy. Select it and copy it by hand.');
    }
  };

  if (created) {
    const address = `${window.location.origin}/login`;
    const everything = `MezMitra login\nAddress: ${address}\nEmail: ${created.email}\nPassword: ${created.password}`;
    return (
      <Modal
        size="sm"
        title="Restaurant added"
        description={`${created.name} can sign in now. Send these details to the owner yourself.`}
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpen(created.id)}>
              Open restaurant
            </Button>
            <Button onClick={onClose} data-autofocus>
              Done
            </Button>
          </>
        }
      >
        <dl className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-slate-50/60 px-4">
          <Detail label="Sign-in address" value={address} onCopy={copy} />
          <Detail label="Email" value={created.email} onCopy={copy} />
          <Detail label="Password" value={created.password} onCopy={copy} mono />
        </dl>
        <Button variant="secondary" size="sm" icon={CopyIcon} className="mt-3" onClick={() => copy(everything, 'Login details')}>
          Copy all three
        </Button>
        <Alert tone="warning" className="mt-4">
          This is the only time the password is shown. Ask them to change it in Settings after they sign in. If it is lost, set a new one from the restaurant&rsquo;s page.
        </Alert>
      </Modal>
    );
  }

  return (
    <Modal
      size="sm"
      title="Add a restaurant"
      description="Restaurants can't sign themselves up: you create the login and hand it over."
      onClose={onClose}
      dismissible={!busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Add restaurant
          </Button>
        </>
      }
    >
      {serverError && <Alert className="mb-3">{serverError}</Alert>}
      <div className="space-y-3">
        <Input label="Restaurant name" name="name" value={values.name} onChange={set('name')} error={errors.name} required maxLength={100} autoComplete="off" data-autofocus />
        <Input
          label="Owner's email"
          name="email"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={values.email}
          onChange={set('email')}
          error={errors.email}
          hint="This is what they sign in with."
          required
          autoComplete="off"
        />
        <div>
          <Input
            label="First password"
            name="password"
            value={values.password}
            onChange={set('password')}
            error={errors.password}
            hint="At least 8 characters. Change it if you like; you will see it again once the restaurant is added."
            required
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <button
            type="button"
            onClick={() => setValues((v) => ({ ...v, password: generatePassword() }))}
            className="mt-1.5 rounded-md text-sm font-semibold text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            Make another password
          </button>
        </div>
      </div>
    </Modal>
  );
}

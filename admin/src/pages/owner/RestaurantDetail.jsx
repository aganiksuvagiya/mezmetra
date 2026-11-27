import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../components/Button.jsx';
import { Alert } from '../../components/EmptyState.jsx';
import { Input, PasswordInput } from '../../components/Field.jsx';
import { ChevronLeftIcon } from '../../components/icons.jsx';
import Modal from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { api } from '../../lib/api.js';
import { formatMoney, formatNumber, timeAgo } from '../../lib/format.js';
import { useAction, useDocumentTitle, useQuery } from '../../lib/hooks.js';
import { paidVia } from '../../lib/payments.js';
import { useFmt } from '../../lib/useFmt.js';
import { ACTIVITY_LABELS, activityNote } from './activity.js';
import EditRestaurantDialog from './EditRestaurantDialog.jsx';
import SuspendDialog from './SuspendDialog.jsx';
import { Avatar, buttonClass, Figures, Label, Panel, Row, Section } from './ui.jsx';

const WAYS = { cash: 'Pay at counter', razorpay: 'Razorpay', phonepe: 'PhonePe' };

/** How one way of paying stands: on, set up but off, not set up, or hidden for everyone by the platform. */
function wayState(w) {
  if (!w.offered) return ['gray', 'Hidden by platform'];
  if (w.enabled && w.configured) return ['green', 'On'];
  if (w.enabled) return ['orange', 'On, not set up'];
  if (w.configured) return ['gray', 'Set up, off'];
  return ['gray', 'Not set up'];
}

const ORDER_STATUS = { pending: ['orange', 'Pending'], accepted: ['blue', 'Accepted'], completed: ['green', 'Completed'], cancelled: ['gray', 'Cancelled'] };
function payState(o) {
  if (o.payment_status === 'refunded') return ['gray', 'Refunded'];
  if (o.payment_status === 'paid') return ['green', `Paid${paidVia(o.payment_method)}`];
  return ['red', 'Unpaid'];
}

/** The owner types a new password for a restaurant that is locked out. They are told to change it themselves afterwards. */
function SetPasswordDialog({ restaurant, onClose, onDone }) {
  const [run, busy] = useAction();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState(null);

  const submit = (event) => {
    event.preventDefault();
    if (password.length < 8) return setError('Use at least 8 characters.');
    if (password !== again) return setError('The two passwords are not the same.');
    return run(async () => {
      setError(null);
      try {
        await api(`/api/platform/restaurants/${restaurant.id}/password`, { method: 'POST', body: { password } });
        onDone();
      } catch (e) {
        setError(e.message || 'Something went wrong. Please try again.');
      }
    });
  };

  return (
    <Modal
      size="sm"
      title={`Set a new password for ${restaurant.name}`}
      description="Everyone signed in as this restaurant is signed out. Tell them the new password yourself, and ask them to change it in Settings."
      onClose={onClose}
      dismissible={!busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Set password
          </Button>
        </>
      }
    >
      {error && <Alert className="mb-3">{error}</Alert>}
      <div className="space-y-3">
        <PasswordInput label="New password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" data-autofocus />
        <PasswordInput label="Type it again" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
      </div>
    </Modal>
  );
}

/** Delete needs the restaurant's name typed, so it can never be done by a stray click. */
function DeleteDialog({ restaurant, onClose, onDone }) {
  const [run, busy] = useAction();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState(null);
  const matches = typed.trim() === restaurant.name;

  const submit = (event) => {
    event.preventDefault();
    if (!matches) return;
    run(async () => {
      setError(null);
      try {
        await api(`/api/platform/restaurants/${restaurant.id}/delete`, { method: 'POST', body: { confirm_name: typed.trim() } });
        onDone();
      } catch (e) {
        setError(e.message || 'Something went wrong. Please try again.');
      }
    });
  };

  return (
    <Modal
      role="alertdialog"
      size="sm"
      title={`Delete ${restaurant.name}?`}
      description={`This permanently deletes the restaurant and everything of it: ${formatNumber(restaurant.orders_total)} orders, ${formatNumber(restaurant.tables)} tables and ${formatNumber(restaurant.items)} dishes. It cannot be undone.`}
      onClose={onClose}
      dismissible={!busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </Button>
          <Button type="submit" variant="danger" busy={busy} disabled={!matches}>
            Delete for good
          </Button>
        </>
      }
    >
      {error && <Alert className="mb-3">{error}</Alert>}
      <Input
        label={`Type “${restaurant.name}” to confirm`}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
      />
    </Modal>
  );
}

function DetailSkeleton() {
  return (
    <div className="mt-4 space-y-6" role="status" aria-label="Loading restaurant">
      <div className="flex items-center gap-4">
        <span className="k-fill size-12 animate-pulse rounded-lg" />
        <span className="space-y-2">
          <span className="k-fill block h-6 w-56 animate-pulse rounded" />
          <span className="k-fill block h-3.5 w-40 animate-pulse rounded" />
        </span>
      </div>
      <div className="k-fill h-24 animate-pulse rounded-xl" />
      <div className="k-fill h-48 animate-pulse rounded-xl" />
    </div>
  );
}

/** One restaurant in full, and what the owner can do about it. */
export default function RestaurantDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const fmt = useFmt();
  const [run, busy] = useAction();
  const q = useQuery(() => api(`/api/platform/restaurants/${id}`), [id], { interval: 30_000 });
  const d = q.data;
  const [dialog, setDialog] = useState(null); // 'edit' | 'suspend' | 'password' | 'delete' | null
  useDocumentTitle(d ? `${d.name} · Owner console` : 'Restaurant · Owner console');

  const suspended = d?.status === 'suspended';
  const protectedAccount = Boolean(d?.is_platform_owner);
  const close = () => setDialog(null);

  const reactivate = () =>
    run(async () => {
      try {
        await api(`/api/platform/restaurants/${d.id}`, { method: 'PATCH', body: { suspended: false } });
        toast.success(`${d.name} is active again.`);
        q.reload();
      } catch (e) {
        toast.error(e.message || "Couldn't reactivate. Please try again.");
      }
    });

  return (
    <>
      <Link to="/owner" className={`${buttonClass.link} -ml-1.5 gap-0.5`}>
        <ChevronLeftIcon size={16} />
        Restaurants
      </Link>

      {q.loading && <DetailSkeleton />}
      {!q.loading && !d && (
        <Panel className="mt-4 px-4 py-12 text-center">
          <p className="text-[0.9375rem] font-semibold">{q.error?.status === 404 ? 'Restaurant not found' : "Couldn't load this restaurant"}</p>
          <p className="k-l2 mt-1 text-[0.875rem]">{q.error?.status === 404 ? 'It may have been deleted.' : q.error?.message || 'Please try again.'}</p>
          <button type="button" className={`${buttonClass.gray} mt-3`} onClick={q.error?.status === 404 ? () => navigate('/owner') : q.reload}>
            {q.error?.status === 404 ? 'Back to restaurants' : 'Try again'}
          </button>
        </Panel>
      )}

      {d && (
        <div className="mt-3 space-y-6">
          <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
            <div className="flex min-w-0 items-center gap-4">
              <Avatar size="lg" name={d.name} muted={suspended} />
              <div className="min-w-0">
                <h1 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[1.75rem] font-bold leading-tight tracking-[-0.025em]">
                  <span className="break-words">{d.name}</span>
                  {protectedAccount && <Label tone="blue">Platform owner</Label>}
                  <Label tone={suspended ? 'red' : 'green'}>{suspended ? 'Suspended' : 'Active'}</Label>
                </h1>
                <p className="k-l2 break-all text-[0.9375rem]">{d.email}</p>
                <p className="k-l3 text-[0.8125rem]">Joined {fmt.dateTime(d.created_at)}</p>
                {suspended && (
                  <p className="k-red mt-1 text-[0.875rem]">
                    Suspended {fmt.dateTime(d.suspended_at)}
                    {d.suspended_reason ? `: ${d.suspended_reason}` : ''}
                  </p>
                )}
              </div>
            </div>
            {protectedAccount ? (
              <p className="k-l2 max-w-xs text-[0.875rem]">This is a platform owner account. It can&rsquo;t be suspended or deleted from here.</p>
            ) : (
              <div className="flex items-center gap-2">
                <button type="button" className={buttonClass.gray} onClick={() => setDialog('edit')} disabled={busy}>
                  Edit details
                </button>
                {suspended ? (
                  <button type="button" className={buttonClass.primary} onClick={reactivate} disabled={busy}>
                    Reactivate
                  </button>
                ) : (
                  <button type="button" className={buttonClass.danger} onClick={() => setDialog('suspend')} disabled={busy}>
                    Suspend
                  </button>
                )}
              </div>
            )}
          </header>

          <Figures
            items={[
              { label: 'Orders · 30 days', value: formatNumber(d.orders_30d), note: `${formatNumber(d.orders_total)} in total` },
              { label: 'Paid · 30 days', value: formatMoney(d.revenue_30d), note: `${formatMoney(d.revenue_total)} in total` },
              { label: 'Menu', value: formatNumber(d.items), unit: d.items === 1 ? 'dish' : 'dishes', note: `${formatNumber(d.categories)} categories · ${formatNumber(d.tables)} tables` },
              { label: 'Last order', value: d.last_order_at ? timeAgo(d.last_order_at) : 'None yet', note: d.last_order_at ? fmt.dateTime(d.last_order_at) : 'No orders so far' },
            ]}
          />

          <div className="grid gap-6 lg:grid-cols-3">
            <Section title="Recent orders" hint="Latest 10" className="lg:col-span-2">
              <Panel divided>
                {d.recent_orders.length === 0 ? (
                  <p className="k-l2 px-4 py-10 text-center text-[0.9375rem]">No orders yet. Orders from this restaurant&rsquo;s tables will show here.</p>
                ) : (
                  d.recent_orders.map((o) => {
                    const [st, stText] = ORDER_STATUS[o.status] ?? ['gray', o.status];
                    const [pt, ptText] = payState(o);
                    return (
                      <Row
                        key={`${o.number}-${o.created_at}`}
                        title={
                          <>
                            #{o.number} <span className="k-l2 font-normal">Table {o.table_number}</span>
                          </>
                        }
                        sub={fmt.dateTime(o.created_at)}
                        right={
                          <span className="flex flex-wrap items-center justify-end gap-1.5">
                            <Label tone={st}>{stText}</Label>
                            <Label tone={pt}>{ptText}</Label>
                            <span className="ml-1 w-16 text-right font-semibold tabular-nums">{formatMoney(o.total)}</span>
                          </span>
                        }
                      />
                    );
                  })
                )}
              </Panel>
            </Section>

            <div className="space-y-6">
              <Section title="Payments" hint="How diners can pay">
                <Panel divided>
                  {d.payment
                    .filter((w) => w.offered || w.enabled)
                    .map((w) => {
                      const [tone, label] = wayState(w);
                      return <Row key={w.key} title={WAYS[w.key]} right={<Label tone={tone}>{label}</Label>} />;
                    })}
                </Panel>
              </Section>

              <Section title="Account">
                <Panel divided>
                  <Row title="Time zone" right={d.timezone} />
                  <Row title="Currency" right={d.currency} />
                  <Row title="Tax" right={`${d.tax_percent}%`} />
                </Panel>
              </Section>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Section title="Owner activity" hint="What was done from this console" className="lg:col-span-2">
              <Panel divided>
                {d.activity.length === 0 ? (
                  <p className="k-l2 px-4 py-6 text-[0.9375rem]">Nothing yet.</p>
                ) : (
                  d.activity.map((a, i) => (
                    <div key={`${a.at}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-3">
                      <p className="min-w-0 break-words text-[0.9375rem] font-medium">
                        {ACTIVITY_LABELS[a.action] ?? a.action}
                        {activityNote(a) && <span className="k-l2 font-normal">: {activityNote(a)}</span>}
                      </p>
                      <p className="k-l3 text-[0.8125rem]" title={fmt.dateTime(a.at)}>
                        {a.by} · {timeAgo(a.at)}
                      </p>
                    </div>
                  ))
                )}
              </Panel>
            </Section>

            {!protectedAccount && (
              <Section title="Account actions">
                <Panel divided>
                  <Row
                    title="Set a new password"
                    sub="For a restaurant that is locked out. They are signed out everywhere."
                    right={
                      <button type="button" className={buttonClass.link} onClick={() => setDialog('password')}>
                        Set password
                      </button>
                    }
                  />
                  <Row
                    title={<span className="k-red">Delete restaurant</span>}
                    sub={suspended ? 'Removes it and all its data for good.' : 'Suspend it first. Only a suspended restaurant can be deleted.'}
                    right={
                      <button type="button" className={buttonClass.danger} disabled={!suspended} onClick={() => setDialog('delete')}>
                        Delete…
                      </button>
                    }
                  />
                </Panel>
              </Section>
            )}
          </div>
        </div>
      )}

      {dialog === 'edit' && d && (
        <EditRestaurantDialog
          restaurant={d}
          onClose={close}
          onDone={() => {
            toast.success('Details saved.');
            close();
            q.reload();
          }}
        />
      )}
      {dialog === 'suspend' && d && (
        <SuspendDialog
          restaurant={d}
          onClose={close}
          onDone={() => {
            toast.success(`${d.name} is suspended.`);
            close();
            q.reload();
          }}
        />
      )}
      {dialog === 'password' && d && (
        <SetPasswordDialog
          restaurant={d}
          onClose={close}
          onDone={() => {
            toast.success(`New password set for ${d.name}. They are signed out everywhere.`);
            close();
            q.reload();
          }}
        />
      )}
      {dialog === 'delete' && d && (
        <DeleteDialog
          restaurant={d}
          onClose={close}
          onDone={() => {
            toast.success(`${d.name} was deleted.`);
            navigate('/owner');
          }}
        />
      )}
    </>
  );
}

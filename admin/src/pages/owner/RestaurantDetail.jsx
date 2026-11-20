import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, PaymentBadge, StatusBadge } from '../../components/Badge.jsx';
import { Button } from '../../components/Button.jsx';
import { Card, CardHeader } from '../../components/Card.jsx';
import { Alert, EmptyState, ErrorState } from '../../components/EmptyState.jsx';
import { Input, PasswordInput } from '../../components/Field.jsx';
import { ChevronLeftIcon, OrdersIcon, ShieldIcon, TrendingIcon } from '../../components/icons.jsx';
import Modal from '../../components/Modal.jsx';
import { Skeleton } from '../../components/Spinner.jsx';
import { useToast } from '../../components/Toast.jsx';
import { api } from '../../lib/api.js';
import { auth } from '../../lib/auth.js';
import { cx } from '../../lib/cx.js';
import { formatMoney, formatNumber, timeAgo } from '../../lib/format.js';
import { useAction, useDocumentTitle, useQuery } from '../../lib/hooks.js';
import { useFmt } from '../../lib/useFmt.js';
import { ACTIVITY_LABELS, activityNote } from './activity.js';
import EditRestaurantDialog from './EditRestaurantDialog.jsx';
import RestaurantAvatar from './RestaurantAvatar.jsx';
import SuspendDialog from './SuspendDialog.jsx';

const WAYS = { cash: 'Pay at counter', upi: 'UPI ID', razorpay: 'Razorpay', cashfree: 'Cashfree', phonepe: 'PhonePe', paytm: 'Paytm' };

/** How one way of paying stands: on, set up but off, not set up, or hidden for everyone by the platform. */
function wayState(w) {
  if (!w.offered) return ['slate', 'Hidden by platform'];
  if (w.enabled && w.configured) return ['green', 'On'];
  if (w.enabled) return ['amber', 'On, not set up'];
  if (w.configured) return ['slate', 'Set up, off'];
  return ['slate', 'Not set up'];
}

function Stat({ icon: Icon, label, value, note, tone = 'brand' }) {
  const tiles = { brand: 'bg-brand-50 text-brand-600', emerald: 'bg-emerald-50 text-emerald-600', sky: 'bg-sky-50 text-sky-600' };
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-lg', tiles[tone])}>
          <Icon size={20} />
        </span>
        <p className="text-sm font-medium text-slate-500">{label}</p>
      </div>
      <p className="mt-3 text-2xl font-bold tracking-tight text-slate-900 tabular-nums sm:text-3xl">{value}</p>
      {note && <p className="mt-1 text-sm text-slate-500">{note}</p>}
    </Card>
  );
}

function Fact({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-slate-900">{children}</dd>
    </div>
  );
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

/** Explains what "log in as" is, then opens that restaurant's admin for up to an hour (the owner's own session waits aside). */
function LoginAsDialog({ restaurant, onClose }) {
  const [run, busy] = useAction();
  const [error, setError] = useState(null);

  const go = () =>
    run(async () => {
      setError(null);
      try {
        const res = await api(`/api/platform/restaurants/${restaurant.id}/login-as`, { method: 'POST' });
        auth.startLoginAs(res.token);
        window.location.assign('/'); // a fresh start as that restaurant: nothing of the owner's session is left on screen
      } catch (e) {
        setError(e.message || 'Something went wrong. Please try again.');
      }
    });

  return (
    <Modal
      size="sm"
      title={`Log in as ${restaurant.name}?`}
      description="You will see their admin exactly as they do, for up to an hour. What you change there is real. A bar at the top takes you back to the owner console, and this is recorded in their activity."
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={go} busy={busy}>
            Log in as {restaurant.name}
          </Button>
        </>
      }
    >
      {error ? <Alert>{error}</Alert> : <p className="text-sm text-slate-600">Your own owner session is kept safe and comes back when you press &ldquo;Back to owner console&rdquo;.</p>}
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
    <div className="space-y-4 sm:space-y-6" role="status" aria-label="Loading restaurant">
      <Skeleton className="h-28 rounded-xl" />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
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
  const [dialog, setDialog] = useState(null); // 'edit' | 'suspend' | 'password' | 'login' | 'delete' | null
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
      <Link to="/owner" className="mb-4 inline-flex items-center gap-1 rounded-md text-sm font-medium text-slate-500 hover:text-slate-900">
        <ChevronLeftIcon size={16} />
        All restaurants
      </Link>

      {q.loading && <DetailSkeleton />}
      {!q.loading && !d && (
        <Card>
          {q.error?.status === 404 ? (
            <EmptyState icon={ShieldIcon} title="Restaurant not found" message="It may have been deleted." action={<Button onClick={() => navigate('/owner')}>Back to restaurants</Button>} />
          ) : (
            <ErrorState error={q.error} onRetry={q.reload} title="Couldn't load this restaurant" />
          )}
        </Card>
      )}

      {d && (
        <div className="space-y-4 sm:space-y-6">
          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-start gap-x-4 gap-y-4">
              <RestaurantAvatar name={d.name} suspended={suspended} size="lg" />
              <div className="min-w-[12rem] flex-1">
                <h1 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
                  <span className="break-words">{d.name}</span>
                  {protectedAccount && <Badge tone="blue" dot={false}>Platform owner</Badge>}
                  <Badge tone={suspended ? 'red' : 'green'}>{suspended ? 'Suspended' : 'Active'}</Badge>
                </h1>
                <p className="mt-0.5 break-all text-sm text-slate-500">{d.email}</p>
                <p className="mt-0.5 text-xs text-slate-400">Joined {fmt.dateTime(d.created_at)}</p>
                {suspended && (
                  <p className="mt-2 text-sm text-red-700">
                    Suspended {fmt.dateTime(d.suspended_at)}
                    {d.suspended_reason ? `: ${d.suspended_reason}` : ''}
                  </p>
                )}
              </div>
              {protectedAccount ? (
                <p className="max-w-xs text-sm text-slate-500">This is a platform owner account. It can&rsquo;t be suspended, deleted or logged in as from here.</p>
              ) : (
                <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                  <Button onClick={() => setDialog('login')} disabled={suspended || busy} title={suspended ? 'Reactivate it first: a suspended restaurant cannot be opened' : undefined}>
                    Log in as
                  </Button>
                  <Button variant="secondary" onClick={() => setDialog('edit')} disabled={busy}>
                    Edit details
                  </Button>
                  {suspended ? (
                    <Button variant="secondary" onClick={reactivate} busy={busy}>
                      Reactivate
                    </Button>
                  ) : (
                    <Button variant="danger-outline" onClick={() => setDialog('suspend')} disabled={busy}>
                      Suspend
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Stat icon={OrdersIcon} tone="sky" label="Orders · 30 days" value={formatNumber(d.orders_30d)} note={`${formatNumber(d.orders_total)} in total`} />
            <Stat icon={TrendingIcon} tone="emerald" label="Paid · 30 days" value={formatMoney(d.revenue_30d)} note={`${formatMoney(d.revenue_total)} in total`} />
            <Stat icon={ShieldIcon} label="Menu" value={`${formatNumber(d.items)} dishes`} note={`${formatNumber(d.categories)} categories · ${formatNumber(d.tables)} tables`} />
            <Stat icon={OrdersIcon} label="Last order" value={d.last_order_at ? timeAgo(d.last_order_at) : 'None yet'} note={d.last_order_at ? fmt.dateTime(d.last_order_at) : 'No orders so far'} />
          </div>

          <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
            <Card className="overflow-hidden lg:col-span-2">
              <CardHeader title="Recent orders" description="The latest 10, newest first." />
              {d.recent_orders.length === 0 ? (
                <EmptyState icon={OrdersIcon} title="No orders yet" message="Orders from this restaurant's tables will show here." />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {d.recent_orders.map((o) => (
                    <li key={`${o.number}-${o.created_at}`} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 sm:px-5">
                      <div className="w-28 shrink-0">
                        <p className="font-semibold text-slate-900">
                          #{o.number} <span className="font-normal text-slate-500">Table {o.table_number}</span>
                        </p>
                        <p className="text-xs text-slate-400">{fmt.dateTime(o.created_at)}</p>
                      </div>
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                        <StatusBadge status={o.status} />
                        <PaymentBadge status={o.payment_status} method={o.payment_method} />
                      </div>
                      <p className="font-semibold tabular-nums text-slate-900">{formatMoney(o.total)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <div className="space-y-4 sm:space-y-6">
              <Card>
                <CardHeader title="Payments" description="How diners can pay here." />
                <ul className="divide-y divide-slate-100 px-4 sm:px-5">
                  {d.payment
                    .filter((w) => w.offered || w.enabled)
                    .map((w) => {
                      const [tone, label] = wayState(w);
                      return (
                        <li key={w.key} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                          <span className="font-medium text-slate-800">{WAYS[w.key]}</span>
                          <Badge tone={tone} dot={tone !== 'slate'}>{label}</Badge>
                        </li>
                      );
                    })}
                </ul>
              </Card>

              <Card>
                <CardHeader title="Account" />
                <dl className="divide-y divide-slate-100 px-4 sm:px-5">
                  <Fact label="Time zone">{d.timezone}</Fact>
                  <Fact label="Currency">{d.currency}</Fact>
                  <Fact label="Tax">{d.tax_percent}%</Fact>
                </dl>
              </Card>
            </div>
          </div>

          <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Owner activity" description="What was done to this restaurant from the owner console." />
              {d.activity.length === 0 ? (
                <p className="px-4 py-5 text-sm text-slate-500 sm:px-5">Nothing yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {d.activity.map((a, i) => (
                    <li key={`${a.at}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2.5 text-sm sm:px-5">
                      <p className="font-medium text-slate-900">
                        {ACTIVITY_LABELS[a.action] ?? a.action}
                        {activityNote(a) ? <span className="font-normal text-slate-500">: {activityNote(a)}</span> : null}
                      </p>
                      <p className="text-xs text-slate-400" title={fmt.dateTime(a.at)}>
                        {a.by} · {timeAgo(a.at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {!protectedAccount && (
              <Card>
                <CardHeader title="Account actions" />
                <div className="divide-y divide-slate-100 px-4 sm:px-5">
                  <div className="py-3.5">
                    <p className="text-sm font-semibold text-slate-900">Set a new password</p>
                    <p className="mt-0.5 text-sm text-slate-500">For a restaurant that is locked out. They are signed out everywhere.</p>
                    <Button variant="secondary" size="sm" className="mt-2.5" onClick={() => setDialog('password')}>
                      Set password
                    </Button>
                  </div>
                  <div className="py-3.5">
                    <p className="text-sm font-semibold text-red-700">Delete restaurant</p>
                    <p className="mt-0.5 text-sm text-slate-500">
                      {suspended ? 'Removes it and all its data for good.' : 'Suspend it first. Only a suspended restaurant can be deleted.'}
                    </p>
                    <Button variant="danger-outline" size="sm" className="mt-2.5" disabled={!suspended} onClick={() => setDialog('delete')}>
                      Delete…
                    </Button>
                  </div>
                </div>
              </Card>
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
      {dialog === 'login' && d && <LoginAsDialog restaurant={d} onClose={close} />}
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

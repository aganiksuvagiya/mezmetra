// How the owner's record (platform_audit) reads on screen: one short label per action, and a note for what that action carried.

export const ACTIVITY_LABELS = {
  create: 'Added the restaurant',
  update: 'Changed its details',
  suspend: 'Suspended',
  reactivate: 'Reactivated',
  set_password: 'Set a new password',
  login_as: 'Logged in as the restaurant (an old entry: this was removed)',
  delete: 'Deleted the restaurant',
};

// Order of the filter on the Activity page.
export const ACTIVITY_FILTERS = [
  ['', 'All actions'],
  ['create', 'Added'],
  ['update', 'Details changed'],
  ['suspend', 'Suspended'],
  ['reactivate', 'Reactivated'],
  ['set_password', 'Passwords set'],
  ['delete', 'Deleted'],
];

/** The extra line for an entry: the reason it was suspended, what was changed, or how much went with a deleted restaurant. Empty when there is none. */
export function activityNote(a) {
  const d = a.detail ?? {};
  if (a.action === 'suspend' && d.reason) return d.reason;
  if (a.action === 'update' && d.changes) {
    return [d.changes.name && `Name: ${d.changes.name.from} → ${d.changes.name.to}`, d.changes.email && `Email: ${d.changes.email.from} → ${d.changes.email.to}`].filter(Boolean).join(' · ');
  }
  if (a.action === 'delete' && Number.isFinite(d.orders)) return `${d.orders} ${d.orders === 1 ? 'order' : 'orders'} went with it`;
  return '';
}

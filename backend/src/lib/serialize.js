import { config } from '../config.js';
import { toRupees } from './money.js';

/** The restaurant's menu colours and design, from a row that has theme_primary / theme_accent / theme_style. */
export const themeOut = (row) => ({ primary: row.theme_primary, accent: row.theme_accent, style: row.theme_style ?? 'classic' });

/** URL of the restaurant's logo (served publicly, versioned so a new logo is never served from cache), or null. */
export const logoUrl = (row, vendorId = row.id) => (row.has_logo ? `/api/public/vendors/${vendorId}/logo?v=${row.logo_version}` : null);

export const isSuperAdminEmail = (email) => config.superAdminEmails.has(String(email ?? '').toLowerCase());

export const vendorOut = (v, kitchen = null) => ({
  id: v.id,
  name: v.name,
  email: v.email,
  currency: v.currency,
  timezone: v.timezone,
  tax_percent: Number(v.tax_percent),
  theme: themeOut(v),
  logo_url: logoUrl(v),
  // Whether diners are asked for the code printed on their table: 'off', 'optional' (may skip it) or 'required' (stops orders from people who only have the link).
  table_code_mode: v.table_code_mode ?? 'off',
  // Ways of paying the product offers right now ('cash', 'razorpay', 'phonepe'); the admin hides the rest.
  payment_methods: [...config.paymentMethods],
  // True for the platform owner's account (SUPER_ADMIN_EMAILS): the admin then shows the Platform section.
  is_super_admin: kitchen ? false : isSuperAdminEmail(v.email),
  // 'owner' for the restaurant's own login, 'kitchen' for the kitchen's: the admin then shows the kitchen screen only.
  role: kitchen ? 'kitchen' : 'owner',
  ...(kitchen ? { email: kitchen.email } : {}),
});

export const categoryOut = (c) => ({
  id: c.id,
  name: c.name,
  description: c.description,
  is_active: c.is_active,
  sort_order: c.sort_order,
  item_count: c.item_count === undefined ? undefined : Number(c.item_count),
  created_at: c.created_at,
  updated_at: c.updated_at,
});

export const photoUrl = (item) => (item.has_photo ? `/api/public/items/${item.id}/photo?v=${item.photo_version}` : null);

/** Load option groups (with options) for many items in two queries. Returns Map<itemId, groups[]>. */
export async function loadOptionGroups(q, itemIds) {
  const byItem = new Map();
  if (itemIds.length === 0) return byItem;
  const groups = await q.query(
    `SELECT id, item_id, name, multi_select, required
       FROM option_groups WHERE item_id = ANY($1::bigint[]) ORDER BY sort_order, id`,
    [itemIds],
  );
  const options = groups.rows.length
    ? await q.query(
        `SELECT id, group_id, name, price_paise
           FROM options WHERE group_id = ANY($1::bigint[]) ORDER BY sort_order, id`,
        [groups.rows.map((g) => g.id)],
      )
    : { rows: [] };

  const optsByGroup = new Map();
  for (const o of options.rows) {
    if (!optsByGroup.has(o.group_id)) optsByGroup.set(o.group_id, []);
    optsByGroup.get(o.group_id).push({ id: o.id, name: o.name, price: toRupees(o.price_paise) });
  }
  for (const g of groups.rows) {
    if (!byItem.has(g.item_id)) byItem.set(g.item_id, []);
    byItem.get(g.item_id).push({
      id: g.id,
      name: g.name,
      multi_select: g.multi_select,
      required: g.required,
      options: optsByGroup.get(g.id) ?? [],
    });
  }
  return byItem;
}

export const itemOut = (item, groups = []) => ({
  id: item.id,
  category_id: item.category_id,
  category_name: item.category_name,
  name: item.name,
  description: item.description,
  price: toRupees(item.price_paise),
  is_active: item.is_active,
  is_featured: item.is_featured,
  is_sold_out: Boolean(item.is_sold_out),
  diet: item.diet ?? null,
  photo_url: photoUrl(item),
  option_groups: groups,
  created_at: item.created_at,
  updated_at: item.updated_at,
});

export const tableOut = (t, qrUrl) => ({
  id: t.id,
  number: t.number,
  capacity: t.capacity,
  area: t.area,
  is_active: t.is_active,
  availability: !t.is_active ? 'maintenance' : t.occupied ? 'occupied' : 'available',
  qr_url: qrUrl,
  code: t.code, // the 4 digits printed on the table's QR card (asked for when the restaurant requires it)
  created_at: t.created_at,
  updated_at: t.updated_at,
});

/** Load line items for many orders. Returns Map<orderId, items[]>. */
export async function loadOrderItems(q, orderIds) {
  const byOrder = new Map();
  if (orderIds.length === 0) return byOrder;
  const { rows } = await q.query(
    `SELECT oi.id, oi.order_id, oi.name, oi.unit_price_paise, oi.quantity, oi.instructions, oi.options, oi.line_total_paise,
            i.id AS dish_id, i.has_photo, i.photo_version
       FROM order_items oi LEFT JOIN items i ON i.id = oi.item_id
      WHERE oi.order_id = ANY($1::bigint[]) ORDER BY oi.id`,
    [orderIds],
  );
  for (const r of rows) {
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
    byOrder.get(r.order_id).push({
      id: r.id,
      name: r.name,
      // The dish's photo, while the dish still exists and has one (an order card shows the first one).
      photo_url: r.dish_id ? photoUrl({ id: r.dish_id, has_photo: r.has_photo, photo_version: r.photo_version }) : null,
      quantity: r.quantity,
      unit_price: toRupees(r.unit_price_paise),
      instructions: r.instructions,
      options: (r.options ?? []).map((o) => ({ group: o.group, name: o.name, price: toRupees(o.price_paise) })),
      line_total: toRupees(r.line_total_paise),
    });
  }
  return byOrder;
}

/**
 * What else there is to know about orders' money: second payments that reached an order which was already paid (to be given back, or
 * given back), and how the refund of the payment that paid the order stands. Returns Map<orderId, { extras, refundState }>.
 */
export async function loadPaymentNotes(q, orderIds) {
  const byOrder = new Map();
  if (orderIds.length === 0) return byOrder;
  const { rows } = await q.query(
    `SELECT id, order_id, provider, amount_paise, status, paid_at, refunded_at, is_extra, refund_state FROM payments
      WHERE order_id = ANY($1::bigint[]) AND (is_extra OR refund_state IS NOT NULL) ORDER BY id`,
    [orderIds],
  );
  for (const p of rows) {
    if (!byOrder.has(p.order_id)) byOrder.set(p.order_id, { extras: [], refundState: null });
    const notes = byOrder.get(p.order_id);
    if (!p.is_extra) notes.refundState = p.refund_state;
    else {
      notes.extras.push({
        id: p.id,
        method: p.provider,
        amount: toRupees(p.amount_paise),
        status: p.status,
        refund_state: p.refund_state,
        paid_at: p.paid_at,
        refunded_at: p.refunded_at,
      });
    }
  }
  return byOrder;
}

const orderBase = (o, items) => ({
  // The restaurant's own order number (#1, #2, ...). `id`, where it is exposed, is the internal key used in URLs.
  number: o.order_no,
  table_number: o.table_number,
  status: o.status,
  payment_status: o.payment_status,
  payment_method: o.payment_method,
  subtotal: toRupees(o.subtotal_paise),
  tax: toRupees(o.tax_paise),
  total: toRupees(o.total_paise),
  note: o.note,
  // The diner typed the code printed on this table (always true when the restaurant requires the code).
  table_code_verified: Boolean(o.table_code_verified),
  items,
  total_quantity: items.reduce((n, i) => n + i.quantity, 0),
  created_at: o.created_at,
  accepted_at: o.accepted_at,
  ready_at: o.ready_at,
  completed_at: o.completed_at,
  paid_at: o.paid_at,
});

export const adminOrderOut = (o, items, notes) => ({
  id: o.id,
  ...orderBase(o, items),
  pay_pref: o.pay_pref,
  extra_payments: notes?.extras ?? [],
  // Of the payment that paid the order: null (nothing given back), 'pending', 'processed' or 'failed'.
  refund_state: notes?.refundState ?? null,
  receipt_url: o.payment_status === 'paid' ? `/api/admin/orders/${o.id}/receipt.pdf` : null,
});

/** What a customer may see about their own order. Never exposes the numeric id. */
export const publicOrderOut = (o, items, extra = {}) => ({
  token: o.public_token,
  ...orderBase(o, items),
  ...extra,
});

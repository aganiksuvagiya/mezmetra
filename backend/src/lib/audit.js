/**
 * Adds one line to the record (audit_events). `q` is the database, or the transaction the change belongs to. Never put a password,
 * a key, a token or a card detail in `detail`.
 */
export const record = (q, event, { vendorId = null, orderId = null, paymentId = null, actor = null, ip = null, detail = {} } = {}) =>
  q.query(
    `INSERT INTO audit_events (event, vendor_id, order_id, payment_id, actor, ip, detail) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [event, vendorId, orderId, paymentId, actor, ip, JSON.stringify(detail)],
  );

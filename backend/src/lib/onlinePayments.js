// What every way of confirming an online payment has in common: marking the order paid, exactly once.

// Paying online is confirmed by the gateway itself, so the kitchen does not need to press "Accept": a pending order is accepted
// the moment the payment is verified (staff only press "Complete" when it is served). Cancelled and completed orders keep their status.
export const PAID_ONLINE_SQL = (method) => `UPDATE orders
       SET payment_status = 'paid', payment_method = '${method}', paid_at = now(),
           status = CASE WHEN status = 'pending' THEN 'accepted' ELSE status END,
           accepted_at = CASE WHEN status = 'pending' THEN now() ELSE accepted_at END
     WHERE id = $1 RETURNING *`;

/**
 * Records one payment attempt as paid and the order as paid. Safe to call twice (a webhook and the diner's page can both report the
 * same payment): the second call changes nothing and answers false.
 */
export async function markAttemptPaid(db, { orderId, attemptId, paymentId, method }) {
  return db.tx(async (t) => {
    const { rows } = await t.query(`SELECT id, payment_status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (!rows[0] || rows[0].payment_status === 'paid') return false;
    await t.query(`UPDATE payments SET status = 'paid', provider_payment_id = $2, paid_at = now() WHERE id = $1`, [attemptId, paymentId ?? null]);
    await t.query(PAID_ONLINE_SQL(method), [orderId]);
    return true;
  });
}

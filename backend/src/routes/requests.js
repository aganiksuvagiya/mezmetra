import { Router } from 'express';
import { notFound } from '../lib/errors.js';

const out = (r) => ({ id: r.id, table_number: r.table_number, kind: r.kind, created_at: r.created_at });

/** Staff side: the diners' open "call the waiter" / "ask for the bill" requests. */
export function requestsRouter(db) {
  const router = Router();

  router.get('/', async (req, res) => {
    const { rows } = await db.query(
      `SELECT r.id, r.kind, r.created_at, t.number AS table_number
         FROM service_requests r JOIN dining_tables t ON t.id = r.table_id
        WHERE r.vendor_id = $1 AND r.resolved_at IS NULL
        ORDER BY r.id`,
      [req.vendorId],
    );
    res.json({ data: rows.map(out) });
  });

  // Dealt with. Pressing it twice is harmless.
  router.post('/:id/done', async (req, res) => {
    const { rows } = await db.query(
      `UPDATE service_requests r SET resolved_at = COALESCE(r.resolved_at, now())
         FROM dining_tables t
        WHERE r.id = $1 AND r.vendor_id = $2 AND t.id = r.table_id
        RETURNING r.id, r.kind, r.created_at, t.number AS table_number`,
      [req.params.id, req.vendorId],
    );
    if (!rows[0]) throw notFound('Request');
    res.json({ data: out(rows[0]) });
  });

  return router;
}

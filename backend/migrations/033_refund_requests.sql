-- A refund is put on record BEFORE the gateway is asked for it. If the answer never arrives (a time-out, a restart, a failed write),
-- the record says a refund was requested, and the gateway is asked later how it ended.
--   refund_state: requested -> pending | processed | failed.
ALTER TABLE payments DROP CONSTRAINT payments_refund_state_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_refund_state_check CHECK (refund_state IN ('requested', 'pending', 'processed', 'failed')),
  ADD COLUMN refund_requested_at timestamptz;

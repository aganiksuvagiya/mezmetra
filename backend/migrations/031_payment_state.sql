-- The life of a payment, made explicit and auditable.
--   status:       created -> paid | failed;  failed -> paid (it arrived late after all);  paid -> refunded;
--                 refunded -> paid only when the gateway reports that the refund itself failed.
--   refund_state: pending -> processed | failed.
ALTER TABLE payments
  ADD COLUMN last_checked_at   timestamptz, -- when the re-check last asked the gateway about an open attempt
  ADD COLUMN refund_state      text CHECK (refund_state IN ('pending', 'processed', 'failed')),
  ADD COLUMN refund_ref        text,        -- our own id of the refund (PhonePe is asked about it by this id)
  ADD COLUMN refund_checked_at timestamptz,
  ADD COLUMN recorded_by       text;        -- who recorded a cash payment
UPDATE payments SET refund_state = 'processed' WHERE status = 'refunded';
CREATE INDEX payments_open_queue ON payments (last_checked_at) WHERE status = 'created';

-- What happened, when, and by whom: payments, refunds, sign-ins and changes to payment settings. Rows are only ever added.
CREATE TABLE audit_events (
  id         bigserial   PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  event      text        NOT NULL,
  vendor_id  bigint,      -- plain numbers, so the record outlives a deleted restaurant or order
  order_id   bigint,
  payment_id bigint,
  actor      text,        -- an email, 'diner', 'gateway' or 'system'
  ip         text,
  detail     jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_vendor ON audit_events (vendor_id, id DESC);

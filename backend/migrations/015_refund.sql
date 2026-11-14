-- Refunds of online (Razorpay) payments from the admin panel. A refunded order is no longer "paid", so it drops out of revenue.
ALTER TABLE orders DROP CONSTRAINT orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check CHECK (payment_status IN ('unpaid', 'paid', 'refunded'));

ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN ('created', 'paid', 'failed', 'refunded'));
ALTER TABLE payments ADD COLUMN refund_id text, ADD COLUMN refunded_at timestamptz;

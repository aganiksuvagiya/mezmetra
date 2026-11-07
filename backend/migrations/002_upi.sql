-- Direct UPI payments (GPay / PhonePe / Paytm / any UPI app) without a payment gateway.
-- The customer pays from their UPI app and tells us they did ("claim"); staff confirm it in the admin panel.

ALTER TABLE vendor_payment_settings
  ADD COLUMN upi_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN upi_id      text;

ALTER TABLE orders
  ADD COLUMN claim_reference text,
  ADD COLUMN claimed_at      timestamptz;

ALTER TABLE orders DROP CONSTRAINT orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('cash', 'razorpay', 'upi'));

ALTER TABLE orders DROP CONSTRAINT orders_pay_pref_check;
ALTER TABLE orders ADD CONSTRAINT orders_pay_pref_check CHECK (pay_pref IN ('counter', 'online', 'upi'));

ALTER TABLE payments DROP CONSTRAINT payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('cash', 'razorpay', 'upi'));

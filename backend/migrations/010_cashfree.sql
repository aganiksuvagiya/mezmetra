-- Cashfree as a second online payment gateway (lower fees than Razorpay). Like Razorpay, each restaurant brings its own
-- Cashfree account: the App ID is stored as is, the Secret Key encrypted. A restaurant uses one online gateway at a time.

ALTER TABLE vendor_payment_settings
  ADD COLUMN cashfree_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN cashfree_app_id     text,
  ADD COLUMN cashfree_secret_enc text;

ALTER TABLE orders DROP CONSTRAINT orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('cash', 'razorpay', 'upi', 'cashfree'));

ALTER TABLE payments DROP CONSTRAINT payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('cash', 'razorpay', 'upi', 'cashfree'));

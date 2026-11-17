-- PhonePe (PG Standard Checkout v2) and Paytm (PG) as online payment gateways. Like Razorpay and Cashfree, each restaurant brings its
-- own merchant account: ids are stored as they are, secrets encrypted. A restaurant uses one online gateway at a time.
-- *_env says whether the keys are the gateway's sandbox ('sandbox') or real ('live') ones: neither gateway can tell from the key.

ALTER TABLE vendor_payment_settings
  ADD COLUMN phonepe_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN phonepe_client_id      text,
  ADD COLUMN phonepe_client_version text,
  ADD COLUMN phonepe_secret_enc     text,
  ADD COLUMN phonepe_env            text NOT NULL DEFAULT 'sandbox' CHECK (phonepe_env IN ('sandbox', 'live')),
  ADD COLUMN paytm_enabled          boolean NOT NULL DEFAULT false,
  ADD COLUMN paytm_mid              text,
  ADD COLUMN paytm_key_enc          text,
  ADD COLUMN paytm_website          text,
  ADD COLUMN paytm_env              text NOT NULL DEFAULT 'sandbox' CHECK (paytm_env IN ('sandbox', 'live'));

ALTER TABLE orders DROP CONSTRAINT orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('cash', 'razorpay', 'upi', 'cashfree', 'phonepe', 'paytm'));

ALTER TABLE payments DROP CONSTRAINT payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('cash', 'razorpay', 'upi', 'cashfree', 'phonepe', 'paytm'));

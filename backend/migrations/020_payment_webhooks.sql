-- Payment webhooks: the gateway (Razorpay, PhonePe) tells our server when a payment succeeded, even if the diner's browser is closed.
-- Each restaurant has its own gateway account, so each gets its own unguessable webhook address (webhook_key) and its own secrets.
ALTER TABLE vendor_payment_settings
  ADD COLUMN webhook_key text,
  ADD COLUMN razorpay_webhook_secret_enc text, -- the secret typed in Razorpay's dashboard (encrypted); Razorpay signs every call with it
  ADD COLUMN phonepe_webhook_auth_enc text;    -- sha256("username:password") of what was typed in PhonePe's dashboard (encrypted); PhonePe sends it in a header

UPDATE vendor_payment_settings SET webhook_key = replace(gen_random_uuid()::text, '-', '') WHERE webhook_key IS NULL;
ALTER TABLE vendor_payment_settings ALTER COLUMN webhook_key SET DEFAULT replace(gen_random_uuid()::text, '-', '');
ALTER TABLE vendor_payment_settings ALTER COLUMN webhook_key SET NOT NULL;
CREATE UNIQUE INDEX vendor_payment_settings_webhook_key ON vendor_payment_settings (webhook_key);

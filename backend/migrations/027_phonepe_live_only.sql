-- The "Sandbox (test keys)" choice for PhonePe was removed: a restaurant's PhonePe keys are always its live ones.
-- Saved sandbox keys do not work on PhonePe's live servers, so PhonePe is switched off for a restaurant that had them on, and cash at
-- the counter is switched on if that leaves it no way to be paid. The saved keys stay until the restaurant replaces them.
UPDATE vendor_payment_settings
   SET phonepe_enabled = false, updated_at = now()
 WHERE phonepe_enabled AND phonepe_env = 'sandbox';

UPDATE vendor_payment_settings
   SET cash_enabled = true, updated_at = now()
 WHERE NOT cash_enabled
   AND NOT (razorpay_enabled AND razorpay_key_id IS NOT NULL AND razorpay_key_secret_enc IS NOT NULL)
   AND NOT (phonepe_enabled AND phonepe_client_id IS NOT NULL AND phonepe_client_version IS NOT NULL AND phonepe_secret_enc IS NOT NULL);

-- Nothing reads this column any more; it says 'live' so that it never claims otherwise.
ALTER TABLE vendor_payment_settings ALTER COLUMN phonepe_env SET DEFAULT 'live';
UPDATE vendor_payment_settings SET phonepe_env = 'live' WHERE phonepe_env <> 'live';

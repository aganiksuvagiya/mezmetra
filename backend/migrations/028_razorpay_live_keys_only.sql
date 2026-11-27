-- The live server takes only Razorpay's live keys: with a test key (rzp_test_...) payments are pretend, so anyone could get an order
-- marked "Paid" without paying. Razorpay is switched off for a restaurant that has a test key saved, and cash at the counter is
-- switched on if that leaves it no way to be paid. The saved keys stay until the restaurant replaces them.
UPDATE vendor_payment_settings
   SET razorpay_enabled = false, updated_at = now()
 WHERE razorpay_enabled AND starts_with(razorpay_key_id, 'rzp_test_');

UPDATE vendor_payment_settings
   SET cash_enabled = true, updated_at = now()
 WHERE NOT cash_enabled
   AND NOT (razorpay_enabled AND razorpay_key_id IS NOT NULL AND razorpay_key_secret_enc IS NOT NULL)
   AND NOT (phonepe_enabled AND phonepe_client_id IS NOT NULL AND phonepe_client_version IS NOT NULL AND phonepe_secret_enc IS NOT NULL);

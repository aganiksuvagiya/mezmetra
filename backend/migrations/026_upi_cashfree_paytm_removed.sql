-- UPI (the restaurant's own UPI ID / QR), Cashfree and Paytm were removed from the product: it takes cash at the counter, Razorpay
-- and PhonePe. A restaurant that was paid only through one of those would be left with no way to be paid, and its diners could not
-- order, so cash at the counter is switched on for it (it can switch it off again once Razorpay or PhonePe is set up).
-- The old columns, the uploaded UPI QR and the orders paid those ways are left as they are: nothing is deleted.
UPDATE vendor_payment_settings
   SET cash_enabled = true, updated_at = now()
 WHERE NOT cash_enabled
   AND NOT (razorpay_enabled AND razorpay_key_id IS NOT NULL AND razorpay_key_secret_enc IS NOT NULL)
   AND NOT (phonepe_enabled AND phonepe_client_id IS NOT NULL AND phonepe_client_version IS NOT NULL AND phonepe_secret_enc IS NOT NULL);

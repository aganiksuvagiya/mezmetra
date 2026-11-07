-- The "Pay with Google Pay / PhonePe / Paytm" buttons open the app with a pre-filled payment link. Apps such as Google Pay and PhonePe
-- refuse these for an ordinary (personal) UPI ID ("bank limit exceeded", "security reasons"), so they stay off unless the restaurant says
-- its UPI ID is a business (merchant) one. Diners can always pay by typing the UPI ID or mobile number.
ALTER TABLE vendor_payment_settings ADD COLUMN upi_pay_buttons boolean NOT NULL DEFAULT false;

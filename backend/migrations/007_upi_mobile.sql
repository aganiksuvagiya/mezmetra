-- A restaurant can also take UPI payments to its mobile number: diners send money to it from any UPI app ("Pay phone number"),
-- which works where Google Pay refuses pre-filled links to a personal UPI ID. Stored as 10 digits, without +91.
ALTER TABLE vendor_payment_settings ADD COLUMN upi_mobile text CHECK (upi_mobile IS NULL OR upi_mobile ~ '^[6-9][0-9]{9}$');

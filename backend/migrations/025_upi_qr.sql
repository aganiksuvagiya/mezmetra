-- A business UPI ID from PhonePe Business or Paytm for Business accepts money only through its own QR code: the apps answer a
-- payment link with "as per UPI guidelines, payment through a link is not allowed for this merchant, please scan the merchant's
-- QR code". So the restaurant can upload that QR (admin -> Payments); diners then see it on their order page and scan it.
-- Kept in Postgres in its own table, like the logo, so settings queries never drag the bytes along.
ALTER TABLE vendor_payment_settings
  ADD COLUMN has_upi_qr     boolean NOT NULL DEFAULT false,
  ADD COLUMN upi_qr_version integer NOT NULL DEFAULT 0;

CREATE TABLE vendor_upi_qr (
  vendor_id bigint PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  mime      text  NOT NULL,
  data      bytea NOT NULL
);

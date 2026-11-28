-- What a restaurant wants printed on its bills. All optional; empty means "not printed".
-- With a GSTIN the bill is headed "Tax Invoice" and its tax is shown as CGST and SGST.
ALTER TABLE vendors
  ADD COLUMN bill_name    text NOT NULL DEFAULT '' CHECK (length(bill_name) <= 120),   -- the registered business name, if not the restaurant's
  ADD COLUMN bill_address text NOT NULL DEFAULT '' CHECK (length(bill_address) <= 200),
  ADD COLUMN gstin        text NOT NULL DEFAULT '' CHECK (gstin = '' OR gstin ~ '^[0-9]{2}[0-9A-Z]{13}$'),
  ADD COLUMN fssai        text NOT NULL DEFAULT '' CHECK (fssai = '' OR fssai ~ '^[0-9]{14}$'),
  ADD COLUMN bill_contact text NOT NULL DEFAULT '' CHECK (length(bill_contact) <= 120); -- phone and/or email for questions

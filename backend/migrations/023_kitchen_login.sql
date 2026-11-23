-- A restaurant can give its kitchen a login of its own (an email and a password): it signs in to the kitchen screen and can do nothing else.
-- One per restaurant for now; `role` is there so another kind of staff login can come later without changing the table.
CREATE TABLE vendor_staff (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id           bigint      NOT NULL UNIQUE REFERENCES vendors(id) ON DELETE CASCADE,
  role                text        NOT NULL DEFAULT 'kitchen' CHECK (role = 'kitchen'),
  email               text        NOT NULL,
  password_hash       text        NOT NULL,
  password_changed_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendor_staff_email_idx ON vendor_staff (lower(email));

-- Password reset by email. Only a hash of the token is stored, so a database leak does not hand out working reset links.
CREATE TABLE password_resets (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id  bigint      NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  token_hash text        NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX password_resets_token_key ON password_resets (token_hash);
CREATE INDEX password_resets_vendor_idx ON password_resets (vendor_id, created_at DESC);

-- Set when the password changes: sign-in tokens issued before this moment stop working.
ALTER TABLE vendors ADD COLUMN password_changed_at timestamptz;

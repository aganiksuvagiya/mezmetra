-- Two-step sign-in (an authenticator app) for a restaurant's own login: the secret is stored encrypted, recovery codes only as hashes.
ALTER TABLE vendors
  ADD COLUMN totp_secret_enc text,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step  bigint,
  ADD COLUMN recovery_hashes text[] NOT NULL DEFAULT '{}';

-- Sessions that were signed out before they expired.
CREATE TABLE revoked_tokens (
  jti        text        PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

-- New tables get their 4-digit code from a cryptographic source (the API already picks it itself; this covers every other insert).
ALTER TABLE dining_tables ALTER COLUMN code
  SET DEFAULT lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 7))::bit(28)::int) % 10000)::text, 4, '0');

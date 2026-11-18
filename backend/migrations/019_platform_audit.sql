-- What the platform owner did to a restaurant from the owner console (suspend, reactivate, set a password, log in as it, delete it).
-- The restaurant is kept as plain text (no foreign key) so the record outlives a deleted restaurant.
CREATE TABLE platform_audit (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_vendor_id  bigint REFERENCES vendors(id) ON DELETE SET NULL,
  actor_email      text        NOT NULL,
  action           text        NOT NULL CHECK (action IN ('suspend', 'reactivate', 'set_password', 'login_as', 'delete')),
  target_vendor_id bigint      NOT NULL,
  target_name      text        NOT NULL,
  target_email     text        NOT NULL,
  detail           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_target_idx ON platform_audit (target_vendor_id, id DESC);

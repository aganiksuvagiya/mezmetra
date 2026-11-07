-- Per-restaurant colours for the customer menu. Managed from the admin panel (Appearance).
-- Stored as #rrggbb; the customer app derives a full light-to-dark scale from them.

ALTER TABLE vendors
  ADD COLUMN theme_primary text NOT NULL DEFAULT '#2f6f62' CHECK (theme_primary ~ '^#[0-9a-f]{6}$'),
  ADD COLUMN theme_accent  text NOT NULL DEFAULT '#e8872a' CHECK (theme_accent  ~ '^#[0-9a-f]{6}$');

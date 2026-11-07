-- Platform owner controls: a restaurant can be suspended. A suspended restaurant cannot sign in or use the admin API,
-- and its tables stop taking orders. Reactivating clears both columns; nothing else is touched.
ALTER TABLE vendors ADD COLUMN suspended_at timestamptz;
ALTER TABLE vendors ADD COLUMN suspended_reason text;
CREATE INDEX vendors_suspended_idx ON vendors (suspended_at) WHERE suspended_at IS NOT NULL;

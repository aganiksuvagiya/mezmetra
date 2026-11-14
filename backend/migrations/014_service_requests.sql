-- "Call the waiter" and "Ask for the bill" from the diner's phone. At most one open request of each kind per table, so tapping again
-- (or a prankster tapping all day) never piles up; staff press Done when they have dealt with it.
CREATE TABLE service_requests (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id   bigint      NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  table_id    bigint      NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('waiter', 'bill')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX service_requests_one_open ON service_requests (table_id, kind) WHERE resolved_at IS NULL;
CREATE INDEX service_requests_open_idx ON service_requests (vendor_id) WHERE resolved_at IS NULL;

-- Hit counters of the rate limits that protect sign-in, ordering and payments. Kept in the database so that every instance of the API
-- counts together, and a restart does not hand out a fresh allowance. Rows are short-lived and swept away once their window has passed.
CREATE TABLE rate_limits (
  key      text        PRIMARY KEY,
  hits     integer     NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_reset_at ON rate_limits (reset_at);

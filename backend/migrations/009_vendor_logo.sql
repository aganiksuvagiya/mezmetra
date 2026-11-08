-- A restaurant can upload its logo (admin -> Appearance); the customer menu and order pages show it.
-- Like dish photos it is kept in Postgres, in its own table so vendor queries never drag the bytes along.
ALTER TABLE vendors ADD COLUMN has_logo     boolean NOT NULL DEFAULT false;
ALTER TABLE vendors ADD COLUMN logo_version integer NOT NULL DEFAULT 0;

CREATE TABLE vendor_logos (
  vendor_id bigint PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  mime      text  NOT NULL,
  data      bytea NOT NULL
);

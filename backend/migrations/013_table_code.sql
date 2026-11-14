-- Fake-order guard. Every table gets a short random code (printed on its QR card). A restaurant can switch on "ask diners for the
-- table code": then an order is only taken from someone who can read the code on the table, not from anyone who has the QR link.
ALTER TABLE vendors ADD COLUMN require_table_code boolean NOT NULL DEFAULT false;
ALTER TABLE dining_tables ADD COLUMN code text NOT NULL DEFAULT lpad((floor(random() * 10000))::int::text, 4, '0');

-- "Sold out" is different from switching a dish off: a sold-out dish stays on the menu (greyed out, "Sold out") so diners
-- know it exists, but it cannot be ordered. Restaurants flip it many times a day.
ALTER TABLE items ADD COLUMN is_sold_out boolean NOT NULL DEFAULT false;

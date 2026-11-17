-- Every restaurant counts its own orders (#1, #2, #3 ...). Until now the number shown was the id of the shared orders table, so a new
-- restaurant's first order could be #37 and one restaurant could see how busy the others are. The shared id stays as the internal key
-- (URLs, payments); `order_no` is what people see.
ALTER TABLE orders ADD COLUMN order_no integer;
ALTER TABLE vendors ADD COLUMN next_order_no integer NOT NULL DEFAULT 1;

-- Existing orders are numbered in the order they were placed, per restaurant.
UPDATE orders o
   SET order_no = n.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY vendor_id ORDER BY created_at, id) AS rn FROM orders) n
 WHERE n.id = o.id;

UPDATE vendors v SET next_order_no = COALESCE((SELECT max(order_no) FROM orders o WHERE o.vendor_id = v.id), 0) + 1;

ALTER TABLE orders ALTER COLUMN order_no SET NOT NULL;
CREATE UNIQUE INDEX orders_vendor_order_no_key ON orders (vendor_id, order_no);

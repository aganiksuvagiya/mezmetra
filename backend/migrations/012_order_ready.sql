-- "Ready": the kitchen has finished the order (it stays "accepted" until staff complete it). The diner is told on their order page.
ALTER TABLE orders ADD COLUMN ready_at timestamptz;

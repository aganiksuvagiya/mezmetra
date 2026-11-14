-- Veg / egg / non-veg / Jain marker on a dish. NULL = the restaurant has not marked it (we never guess).
ALTER TABLE items ADD COLUMN diet text CHECK (diet IN ('veg', 'egg', 'nonveg', 'jain'));

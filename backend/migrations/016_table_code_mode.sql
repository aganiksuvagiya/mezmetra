-- The table code is now a three-way choice per restaurant instead of an on/off switch:
--   off      diners are never asked for it
--   optional diners may type it; a wrong code is refused, an empty one is fine, and the order is marked "code verified" when it is right
--   required an order is only taken from someone who typed the right code
ALTER TABLE vendors ADD COLUMN table_code_mode text NOT NULL DEFAULT 'off' CHECK (table_code_mode IN ('off', 'optional', 'required'));
UPDATE vendors SET table_code_mode = 'required' WHERE require_table_code;
ALTER TABLE vendors DROP COLUMN require_table_code;

-- True when the diner typed this table's code correctly (always the case when the code is required).
ALTER TABLE orders ADD COLUMN table_code_verified boolean NOT NULL DEFAULT false;

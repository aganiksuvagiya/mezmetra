-- Money that arrives for an order which is already paid (for example cash was recorded while the diner was still paying online) is
-- kept and marked as an extra payment, so the restaurant can see it and give it back.
ALTER TABLE payments ADD COLUMN is_extra boolean NOT NULL DEFAULT false;

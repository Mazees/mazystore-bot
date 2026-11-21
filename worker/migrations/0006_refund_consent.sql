ALTER TABLE orders ADD COLUMN refund_accepted INTEGER NOT NULL DEFAULT 0 CHECK(refund_accepted IN (0,1));

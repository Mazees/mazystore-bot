-- Preserve historical variant IDs without a live foreign key to a deletable catalog row.
ALTER TABLE orders ADD COLUMN variant_snapshot_id TEXT NOT NULL DEFAULT '';
UPDATE orders SET variant_snapshot_id=variant_id;
ALTER TABLE orders DROP COLUMN variant_id;
ALTER TABLE orders RENAME COLUMN variant_snapshot_id TO variant_id;

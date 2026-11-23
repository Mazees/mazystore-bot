ALTER TABLE variants ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'manual' CHECK(delivery_mode IN ('manual','auto'));
ALTER TABLE orders ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'manual' CHECK(delivery_mode IN ('manual','auto'));
CREATE TABLE stock_batches (id TEXT PRIMARY KEY, variant_id TEXT NOT NULL, quantity INTEGER NOT NULL);
CREATE TABLE inventory (
 id TEXT PRIMARY KEY, variant_id TEXT NOT NULL, payload TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','reserved','sold')),
 order_id TEXT REFERENCES orders(id), version INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX inventory_variant ON inventory(variant_id,state,created_at,id);
CREATE INDEX inventory_order ON inventory(order_id);
CREATE TRIGGER validate_inventory_insert BEFORE INSERT ON inventory
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM variants v JOIN categories c ON c.id=v.category_id WHERE v.id=NEW.variant_id AND v.delivery_mode='auto' AND c.deleted=0) THEN RAISE(ABORT,'STOCK_VARIANT_UNAVAILABLE') END;
END;
CREATE TABLE deliveries (
 order_id TEXT NOT NULL REFERENCES orders(id), part INTEGER NOT NULL, wa_id TEXT NOT NULL UNIQUE,
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','received','uncertain','stopped')),
 started INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(order_id,part)
);
CREATE TRIGGER reserve_inventory AFTER INSERT ON orders WHEN NEW.delivery_mode='auto'
BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM inventory WHERE variant_id=NEW.variant_id AND state='available')<NEW.quantity THEN RAISE(ABORT,'STOCK_UNAVAILABLE') END;
 UPDATE inventory SET state='reserved',order_id=NEW.id,version=version+1 WHERE id IN (SELECT id FROM inventory WHERE variant_id=NEW.variant_id AND state='available' ORDER BY created_at,id LIMIT NEW.quantity);
END;
CREATE TRIGGER protect_inventory_edit BEFORE UPDATE OF payload ON inventory WHEN OLD.state!='available'
BEGIN
 SELECT RAISE(ABORT,'STOCK_ALLOCATED');
END;
CREATE TRIGGER protect_inventory_delete BEFORE DELETE ON inventory WHEN OLD.state!='available'
BEGIN
 SELECT RAISE(ABORT,'STOCK_ALLOCATED');
END;
CREATE TRIGGER protect_auto_variant_delete BEFORE DELETE ON variants
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM orders WHERE variant_id=OLD.id AND delivery_mode='auto' AND status NOT IN ('completed','cancelled','refunded')) THEN RAISE(ABORT,'AUTO_ORDER_ACTIVE') END;
 DELETE FROM inventory WHERE variant_id=OLD.id AND state='available';
END;
CREATE TRIGGER inventory_order_status AFTER UPDATE OF status ON orders
BEGIN
 UPDATE deliveries SET state='stopped' WHERE order_id=NEW.id AND state='pending' AND NEW.status!='processing';
 UPDATE inventory SET state='available',order_id=NULL,version=version+1 WHERE order_id=NEW.id AND state='reserved' AND NEW.status IN ('cancelled','refunded') AND NOT EXISTS(SELECT 1 FROM deliveries WHERE order_id=NEW.id AND started=1);
 UPDATE inventory SET state='sold',version=version+1 WHERE order_id=NEW.id AND NEW.status='completed' AND state='reserved';
END;
CREATE TRIGGER protect_auto_category_delete BEFORE UPDATE OF deleted ON categories WHEN NEW.deleted=1
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM orders o JOIN variants v ON v.id=o.variant_id WHERE v.category_id=OLD.id AND o.delivery_mode='auto' AND o.status NOT IN ('completed','cancelled','refunded')) THEN RAISE(ABORT,'AUTO_ORDER_ACTIVE') END;
END;

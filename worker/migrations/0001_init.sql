PRAGMA foreign_keys = ON;
CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO categories VALUES
 (1,'CHATGPT API KEY'),(2,'DEEPSEEK API KEY'),(3,'CLAUDE API KEY'),
 (4,'GEMINI PLUS'),(5,'CHATGPT BUSINESS'),(6,'CHATGPT PLUS'),(7,'GEMINI PRO');
CREATE TABLE variants (
 id TEXT PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id),
 name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price > 0 AND price <= 9999999999),
 terms TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1))
);
INSERT INTO variants(id,category_id,name,price,terms) VALUES
 ('gemini-plus-6bln',4,'6 bulan',35000,'Durasi 6 bulan. Ketentuan layanan perlu dilengkapi admin sebelum dibuka.'),
 ('gpt-business-invite',5,'Private Invite',95000,'Durasi dan ketentuan layanan perlu dilengkapi admin sebelum dibuka.'),
 ('gpt-plus-private',6,'Private / 1 bulan',90000,'Durasi 1 bulan. Ketentuan layanan perlu dilengkapi admin sebelum dibuka.'),
 ('gpt-plus-sharing',6,'Sharing / 1 bulan',40000,'Durasi 1 bulan. Ketentuan layanan perlu dilengkapi admin sebelum dibuka.'),
 ('gemini-pro-invite',7,'Private Invite / 12 bulan',40000,'Durasi 12 bulan. Ketentuan layanan perlu dilengkapi admin sebelum dibuka.');
CREATE TABLE customers (buyer TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE, session TEXT NOT NULL DEFAULT '{}');
CREATE TABLE orders (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, buyer TEXT NOT NULL REFERENCES customers(buyer),
 variant_id TEXT NOT NULL REFERENCES variants(id), product TEXT NOT NULL, variant TEXT NOT NULL,
 terms TEXT NOT NULL, unit_price INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 100),
 total INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('awaiting_payment','awaiting_proof','review','processing','refund_pending','completed','cancelled','refunded')),
 cancel_requested INTEGER NOT NULL DEFAULT 0, proof_relay TEXT NOT NULL DEFAULT 'none',
 qris_version TEXT NOT NULL, last_action_key TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX one_active_order ON orders(buyer) WHERE status NOT IN ('completed','cancelled','refunded');
CREATE INDEX orders_status ON orders(status,created_at);
CREATE TABLE order_actions (action_key TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), action TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX actions_order ON order_actions(order_id);
CREATE TABLE messages (jid TEXT NOT NULL, wa_id TEXT NOT NULL, buyer TEXT NOT NULL REFERENCES customers(buyer), order_id TEXT REFERENCES orders(id), role TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(jid,wa_id));
CREATE INDEX messages_date ON messages(created_at);

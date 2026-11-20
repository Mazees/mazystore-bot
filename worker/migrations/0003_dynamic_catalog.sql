ALTER TABLE categories ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX categories_request_key ON categories(request_key);
CREATE UNIQUE INDEX categories_name_unique ON categories(name COLLATE NOCASE);

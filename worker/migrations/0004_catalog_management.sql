ALTER TABLE categories ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1));
ALTER TABLE categories ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
DROP INDEX categories_name_unique;
CREATE UNIQUE INDEX categories_name_unique ON categories(name COLLATE NOCASE) WHERE deleted=0;

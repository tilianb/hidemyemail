-- Create new blocks table with user_id
CREATE TABLE blocks_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) DEFAULT 1,
  alias_id INTEGER REFERENCES aliases(id),
  pattern TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Copy existing blocks, assuming they belong to user 1 for now (admin)
INSERT INTO blocks_new (id, user_id, alias_id, pattern, created_at)
SELECT id, 1, alias_id, pattern, created_at
FROM blocks;

DROP TABLE blocks;
ALTER TABLE blocks_new RENAME TO blocks;

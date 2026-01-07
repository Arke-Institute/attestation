-- Chain state table for tracking the global attestation chain head
-- This must be strongly consistent (D1) to maintain chain integrity

CREATE TABLE IF NOT EXISTS chain_state (
  key TEXT PRIMARY KEY,
  tx_id TEXT,              -- Latest Arweave TX ID (null for genesis)
  cid TEXT,                -- Latest manifest CID (null for genesis)
  seq INTEGER NOT NULL DEFAULT 0,  -- Monotonic sequence number
  updated_at TEXT NOT NULL
);

-- Initialize head with genesis state
INSERT OR IGNORE INTO chain_state (key, tx_id, cid, seq, updated_at)
VALUES ('head', NULL, NULL, 0, datetime('now'));

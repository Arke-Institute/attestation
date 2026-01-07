# Attestation Worker Implementation Plan

## Overview

Refactor the attestation worker to use sequential processing with a global event chain. Each attestation event links to the previous via `prev_tx` and `prev_cid`, creating a verifiable chain walkable purely on Arweave.

---

## 1. D1 Schema Changes

### Add chain_state table

```sql
CREATE TABLE IF NOT EXISTS chain_state (
  key TEXT PRIMARY KEY,
  tx_id TEXT,
  cid TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Initialize head (genesis state)
INSERT OR IGNORE INTO chain_state (key, tx_id, cid, seq, updated_at)
VALUES ('head', NULL, NULL, 0, datetime('now'));
```

### Verify attestation_queue schema

Ensure existing table has required fields:
- `id`, `entity_id`, `cid`, `op`, `vis`, `ts`, `status`, `created_at`, `updated_at`
- `retry_count`, `error_message`
- Remove `prev_cid` if it exists (no longer needed in queue - comes from chain head)

---

## 2. Updated Payload Schema

```javascript
{
  attestation: {
    pi: "person:john-doe",     // Entity ID
    ver: 3,                     // Entity version
    cid: "bafyabc...",         // THIS event's manifest CID
    op: "update",               // Operation type
    vis: "public",              // Visibility
    ts: 1736246400000,          // Timestamp

    // Global chain links (both point to PREVIOUS event)
    prev_tx: "Hx7kL9m...",     // null for genesis
    prev_cid: "bafydef...",    // null for genesis
    seq: 12345,                 // Monotonic sequence number
  },

  manifest: { ... }             // Self-contained manifest from R2
}
```

---

## 3. Worker Code Changes

### 3.1 Remove parallel processing

Replace `Promise.allSettled` with sequential loop.

### 3.2 New processing flow

```
processQueue():
  1. BEGIN TRANSACTION (D1)
  2. Read head: SELECT * FROM chain_state WHERE key = 'head'
  3. Fetch ONE pending item from attestation_queue (ORDER BY created_at ASC LIMIT 1)
  4. If no items, COMMIT and return
  5. Mark item as 'uploading'
  6. Fetch manifest from R2
  7. Build payload with:
     - prev_tx: head.tx_id (null if genesis)
     - prev_cid: head.cid (null if genesis)
     - seq: head.seq + 1
  8. Upload to Arweave → get new_tx_id
  9. Update chain_state: tx_id = new_tx_id, cid = item.cid, seq = seq + 1
  10. Store in KV index: attest:{entity_id}:{ver} → {cid, tx, ts}
  11. Delete item from queue
  12. COMMIT TRANSACTION
  13. Loop back to step 3 (process next item in same cron run)
```

### 3.3 Batch processing within time limit

```javascript
const MAX_PROCESS_TIME_MS = 25000; // Leave 5s buffer for 30s limit
const startTime = Date.now();

while (Date.now() - startTime < MAX_PROCESS_TIME_MS) {
  const processed = await processOneItem(env);
  if (!processed) break; // No more items
}
```

### 3.4 Error handling

- If Arweave upload fails: mark item as 'failed', don't update head
- If head update fails after upload: LOG CRITICAL (chain integrity issue)
- Consider: store pending TX in separate field before confirming

### 3.5 Genesis handling

First event has `prev_tx: null, prev_cid: null, seq: 1`.

---

## 4. Remove Test Endpoints

Remove from HTTP handler:
- `/test-upload` - performance testing (done)
- `/seed` - test data seeding
- `/test` - batch testing

Keep minimal:
- `/` - health check (read-only, safe)
- `/trigger` - manual trigger (consider auth or remove)
- `/retry` - manual retry (consider auth or remove)

Or remove HTTP entirely, cron-only operation.

---

## 5. Security: Disable Public HTTP

Option A: Remove fetch handler entirely (cron only)

Option B: Add simple auth check:
```javascript
if (request.headers.get('Authorization') !== `Bearer ${env.ADMIN_SECRET}`) {
  return new Response('Unauthorized', { status: 401 });
}
```

---

## 6. KV Index Strategy

Keep KV for fast lookups:
- `attest:{entity_id}:{ver}` → `{cid, tx, ts}`
- `attest:{entity_id}:latest` → `{ver, cid, tx, ts}` (add this)

This allows quick "get latest version for entity" without scanning.

---

## 7. Estimated Throughput

| Arweave Upload Time | Items/Minute | Items/Hour | Items/Day |
|---------------------|--------------|------------|-----------|
| 2s average          | ~12          | ~720       | ~17,280   |
| 3s average          | ~8           | ~480       | ~11,520   |
| 4s average          | ~6           | ~360       | ~8,640    |

If queue backs up, it will drain over subsequent cron cycles.

---

## 8. Implementation Order

1. [ ] Add D1 migration for chain_state table
2. [ ] Update processQueue to sequential with chain linking
3. [ ] Update payload schema (prev_tx, prev_cid, seq)
4. [ ] Add head read/update logic with D1
5. [ ] Add latest pointer to KV index
6. [ ] Remove test endpoints
7. [ ] Add auth or disable HTTP
8. [ ] Test locally with wrangler dev
9. [ ] Deploy and verify chain integrity

---

## 9. Verification Script (Future)

Tool to walk the chain and verify:
- seq numbers are monotonic (no gaps)
- prev_tx/prev_cid match actual previous event
- All CIDs resolve to valid manifests

---

## Questions to Resolve

1. **HTTP access**: Remove entirely or add auth?
2. **Failure recovery**: What if upload succeeds but D1 update fails? (orphaned TX)
3. **Backfill**: Any existing attestations to migrate, or fresh start?

# Parallel Pre-Signing Implementation Plan

## Overview

Improve attestation throughput from ~14k/day to ~700k/day by pre-signing transactions locally (fast) and uploading in parallel (slow part parallelized).

---

## File Structure (Modular Architecture)

```
worker/src/
├── index.ts              # Entry point: HTTP handler + cron scheduler only
├── types.ts              # All TypeScript interfaces/types
├── config.ts             # Constants and configuration
├── arweave.ts            # Arweave client setup and transaction helpers
├── chain/
│   ├── state.ts          # Chain head management (getChainHead, updateChainHead)
│   └── signing.ts        # preSignBatch - sequential signing logic
├── queue/
│   ├── fetch.ts          # Fetch pending items, mark as signing
│   ├── finalize.ts       # finalizeBatch - handle success/failure, update state
│   └── cleanup.ts        # Retry failed, cleanup stuck items
├── upload/
│   └── parallel.ts       # uploadParallel - parallel Arweave uploads
├── manifests/
│   └── fetch.ts          # Fetch manifests from R2 in parallel
└── process.ts            # Main processQueue orchestration
```

### Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `index.ts` | HTTP routes, cron triggers - delegates to `process.ts` |
| `types.ts` | `Env`, `QueueItem`, `Manifest`, `ChainHead`, `PendingTransaction`, `BatchResult` |
| `config.ts` | `BATCH_SIZE`, `MAX_PROCESS_TIME_MS`, `MAX_RETRIES`, `UPLOAD_TIMEOUT` |
| `arweave.ts` | Arweave client instance, `createSignedTx()`, `addTags()` |
| `chain/state.ts` | D1 operations for chain head |
| `chain/signing.ts` | Sequential pre-signing with chain linking |
| `queue/fetch.ts` | Get pending items, lock with batch_id |
| `queue/finalize.ts` | Update KV, delete from queue, handle failures |
| `queue/cleanup.ts` | Daily retry/cleanup jobs |
| `upload/parallel.ts` | `Promise.all` upload with error tracking |
| `manifests/fetch.ts` | Parallel R2 fetches |
| `process.ts` | Orchestrates the full batch flow |

### Module Specifications

#### `types.ts`
```typescript
export interface Env {
  D1_PROD: D1Database;
  R2_MANIFESTS: R2Bucket;
  ATTESTATION_INDEX: KVNamespace;
  ARWEAVE_WALLET: string;
}

export interface ChainHead {
  tx_id: string | null;
  cid: string | null;
  seq: number;
}

export interface QueueItem {
  id: number;
  entity_id: string;
  cid: string;
  op: string;
  vis: string;
  ts: string;
  created_at: string;
  status: string;
  retry_count: number;
  error_message: string | null;
  batch_id: string | null;  // NEW: for batch locking
}

export interface Manifest {
  ver: number;
  [key: string]: unknown;
}

export interface AttestationPayload {
  attestation: {
    pi: string;
    ver: number;
    cid: string;
    op: string;
    vis: string;
    ts: number;
    prev_tx: string | null;
    prev_cid: string | null;
    seq: number;
  };
  manifest: Manifest;
}

export interface PendingTransaction {
  queueItem: QueueItem;
  manifest: Manifest;
  payload: AttestationPayload;
  signedTx: Transaction;  // Arweave Transaction type
  txId: string;
  seq: number;
}

export interface UploadResult {
  txId: string;
  success: boolean;
  error?: Error;
}

export interface BatchResult {
  succeeded: PendingTransaction[];
  failed: { item: PendingTransaction; error: Error }[];
  newHead: { txId: string; cid: string; seq: number } | null;
  stats: {
    signTimeMs: number;
    uploadTimeMs: number;
    finalizeTimeMs: number;
  };
}

export interface ProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  duration: number;
}
```

#### `config.ts`
```typescript
export const CONFIG = {
  BATCH_SIZE: 50,              // Items per batch
  MAX_PROCESS_TIME_MS: 55000,  // 55s processing window
  MAX_RETRIES: 5,              // Max retry attempts
  UPLOAD_TIMEOUT_MS: 30000,    // Per-upload timeout
  SIGNING_TIMEOUT_MS: 10000,   // Total signing timeout
  STUCK_THRESHOLD_MS: 600000,  // 10 min before cleanup
} as const;
```

#### `arweave.ts`
```typescript
import Arweave from "@irys/arweave";
import type { QueueItem, Manifest, AttestationPayload } from "./types";

export const arweave = new Arweave({ url: "https://arweave.net" });

export async function createSignedTransaction(
  wallet: JsonWebKey,
  payload: AttestationPayload,
  item: QueueItem,
  seq: number,
  prevTx: string | null
): Promise<{ tx: Transaction; txId: string }>;

export function addTags(
  tx: Transaction,
  item: QueueItem,
  ver: number,
  seq: number,
  prevTx: string | null
): void;
```

#### `chain/state.ts`
```typescript
import type { Env, ChainHead } from "../types";

export async function getChainHead(env: Env): Promise<ChainHead>;
export async function updateChainHead(
  env: Env,
  txId: string,
  cid: string,
  seq: number
): Promise<void>;
```

#### `chain/signing.ts`
```typescript
import type { Env, QueueItem, Manifest, ChainHead, PendingTransaction } from "../types";

export async function preSignBatch(
  env: Env,
  items: QueueItem[],
  manifests: Map<string, Manifest>,
  head: ChainHead
): Promise<PendingTransaction[]>;
```

#### `queue/fetch.ts`
```typescript
import type { Env, QueueItem } from "../types";

export async function fetchPendingItems(
  env: Env,
  limit: number
): Promise<QueueItem[]>;

export async function markItemsAsSigning(
  env: Env,
  items: QueueItem[],
  batchId: string
): Promise<void>;

export async function getQueueStats(
  env: Env
): Promise<Record<string, number>>;
```

#### `queue/finalize.ts`
```typescript
import type { Env, PendingTransaction, UploadResult, ChainHead, BatchResult } from "../types";

export async function finalizeBatch(
  env: Env,
  pending: PendingTransaction[],
  uploadResults: Map<string, UploadResult>,
  originalHead: ChainHead
): Promise<BatchResult>;
```

#### `queue/cleanup.ts`
```typescript
import type { Env } from "../types";

export async function retryFailedItems(env: Env): Promise<void>;
export async function cleanupStuckItems(env: Env): Promise<void>;
```

#### `upload/parallel.ts`
```typescript
import type { PendingTransaction, UploadResult } from "../types";

export async function uploadParallel(
  pending: PendingTransaction[]
): Promise<Map<string, UploadResult>>;
```

#### `manifests/fetch.ts`
```typescript
import type { Env, QueueItem, Manifest } from "../types";

export async function fetchManifestsParallel(
  env: Env,
  items: QueueItem[]
): Promise<Map<string, Manifest>>;
```

#### `process.ts`
```typescript
import type { Env, ProcessResult } from "./types";

export async function processQueue(env: Env): Promise<ProcessResult>;
```

#### `index.ts` (Entry Point)
```typescript
import { processQueue } from "./process";
import { retryFailedItems, cleanupStuckItems } from "./queue/cleanup";
import { getQueueStats } from "./queue/fetch";
import { getChainHead } from "./chain/state";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response>;
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void>;
};
```

### Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CRON TRIGGER (every minute)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          index.ts → process.ts                               │
│                            processQueue(env)                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
         ┌─────────────────────────────┼─────────────────────────────┐
         ▼                             ▼                             ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│ queue/fetch.ts  │        │ chain/state.ts  │        │ manifests/      │
│ fetchPending(50)│        │ getChainHead()  │        │ fetch.ts        │
│ markAsSigning() │        │                 │        │ fetchParallel() │
└────────┬────────┘        └────────┬────────┘        └────────┬────────┘
         │                          │                          │
         │ QueueItem[]              │ ChainHead                │ Map<cid, Manifest>
         └──────────────────────────┼──────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          chain/signing.ts                                    │
│                      preSignBatch(items, manifests, head)                    │
│                                                                              │
│   FOR EACH item (sequential - fast, ~1-5ms each):                           │
│     1. Build AttestationPayload with prev_tx, prev_cid, seq                 │
│     2. Create Arweave transaction                                            │
│     3. Sign transaction (deterministic TX ID generated)                      │
│     4. Update prev_tx/prev_cid for next iteration                           │
│                                                                              │
│   OUTPUT: PendingTransaction[] with all TX IDs known                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ PendingTransaction[]
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          upload/parallel.ts                                  │
│                         uploadParallel(pending)                              │
│                                                                              │
│   Promise.all(pending.map(p => arweave.transactions.post(p.signedTx)))     │
│                                                                              │
│   OUTPUT: Map<txId, UploadResult>                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Map<txId, UploadResult>
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          queue/finalize.ts                                   │
│                finalizeBatch(pending, uploadResults, originalHead)          │
│                                                                              │
│   1. Find longest successful prefix (chain valid up to first failure)       │
│   2. Update chain head in D1 (chain/state.ts)                               │
│   3. Update KV indexes for succeeded items                                  │
│   4. Delete succeeded items from queue                                       │
│   5. Re-queue failed items as 'pending' (will get new prev_tx next run)    │
│                                                                              │
│   OUTPUT: BatchResult { succeeded, failed, newHead, stats }                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              LOGGING                                         │
│   [ATTESTATION] Batch: 50 items, 48 succeeded, 2 failed, 8.5s              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### State Transitions

```
Queue Item States:

  ┌─────────┐    fetch     ┌─────────┐    upload    ┌─────────┐
  │ pending │ ───────────▶ │ signing │ ────────────▶│ DELETED │  (success)
  └─────────┘              └─────────┘              └─────────┘
       ▲                        │
       │                        │ failure
       │                        ▼
       │                   ┌─────────┐
       └───────────────────│ failed  │
         retry job         └─────────┘
         (daily 4AM)            │
                                │ retry_count >= 5
                                ▼
                          ┌───────────┐
                          │ ABANDONED │ (logged, kept for debugging)
                          └───────────┘
```

## Current vs Proposed

| Aspect | Current (Sequential) | Proposed (Parallel Pre-Sign) |
|--------|---------------------|------------------------------|
| Sign | Sign → Upload → Sign → Upload | Sign all → Upload all |
| Throughput | ~10/min | ~500/min |
| Daily capacity | ~14,400 | ~720,000 |
| Bottleneck | Sequential Arweave uploads | Arweave rate limits (if any) |

---

## Core Concept

### Why This Works

1. **TX ID is deterministic**: `TX_ID = SHA256(signature)` where `signature = sign(tx_data, private_key)`
2. **Signing is local and fast**: ~1-5ms per transaction
3. **We can compute the full chain locally before any uploads**

### The Process

```
CURRENT (Sequential):
  sign(TX_1) → upload(TX_1) → sign(TX_2) → upload(TX_2) → ...
  Time: N × (sign_time + upload_time) ≈ N × 5s

PROPOSED (Parallel Pre-Sign):
  sign(TX_1) → sign(TX_2) → sign(TX_3) → ... → sign(TX_N)  [~50ms total]
  upload(TX_1, TX_2, TX_3, ..., TX_N) in parallel           [~5-10s total]
  Time: sign_time × N + max(upload_times) ≈ 0.05s + 5s = 5s for N items
```

---

## Detailed Implementation

### 1. Data Structures

```typescript
interface PendingTransaction {
  queueItem: QueueItem;        // Original queue record
  manifest: Manifest;          // Fetched from R2
  payload: AttestationPayload; // Built payload with chain links
  signedTx: Transaction;       // Signed Arweave transaction
  txId: string;                // Computed TX ID (from signature)
  seq: number;                 // Sequence number in chain
}

interface BatchResult {
  succeeded: PendingTransaction[];
  failed: { item: PendingTransaction; error: Error }[];
  newHead: { txId: string; cid: string; seq: number } | null;
}
```

### 2. Processing Flow

```typescript
async function processQueueParallel(env: Env): Promise<BatchResult> {
  const BATCH_SIZE = 50; // Tune based on testing

  // 1. FETCH: Get batch of pending items
  const items = await fetchPendingItems(env, BATCH_SIZE);
  if (items.length === 0) return emptyResult();

  // 2. LOCK: Mark all as 'signing' (prevent other workers)
  await markItemsAsSigning(env, items);

  // 3. FETCH MANIFESTS: Get all manifests from R2 in parallel
  const manifests = await fetchManifestsParallel(env, items);

  // 4. GET HEAD: Read current chain head
  const head = await getChainHead(env);

  // 5. PRE-SIGN: Build and sign all transactions sequentially (fast)
  const pending = await preSignBatch(env, items, manifests, head);

  // 6. UPLOAD: Upload all transactions in parallel (slow, now parallelized)
  const results = await uploadParallel(pending);

  // 7. FINALIZE: Update head, KV indexes, remove from queue
  return await finalizeBatch(env, results, head);
}
```

### 3. Pre-Signing Phase (Sequential but Fast)

```typescript
async function preSignBatch(
  env: Env,
  items: QueueItem[],
  manifests: Map<string, Manifest>,
  head: ChainHead
): Promise<PendingTransaction[]> {
  const wallet = JSON.parse(env.ARWEAVE_WALLET);
  const pending: PendingTransaction[] = [];

  let prevTx = head.tx_id;
  let prevCid = head.cid;
  let seq = head.seq;

  for (const item of items) {
    const manifest = manifests.get(item.cid);
    if (!manifest) continue; // Skip if manifest not found

    seq++;

    // Build payload with chain links
    const payload: AttestationPayload = {
      attestation: {
        pi: item.entity_id,
        ver: manifest.ver,
        cid: item.cid,
        op: item.op,
        vis: item.vis,
        ts: new Date(item.ts).getTime(),
        prev_tx: prevTx,
        prev_cid: prevCid,
        seq,
      },
      manifest,
    };

    // Create and sign transaction (LOCAL, FAST)
    const tx = await arweave.createTransaction({
      data: JSON.stringify(payload)
    }, wallet);

    addTags(tx, item, manifest.ver, seq, prevTx);

    await arweave.transactions.sign(tx, wallet);

    // TX ID is now known (derived from signature)
    const txId = tx.id;

    pending.push({
      queueItem: item,
      manifest,
      payload,
      signedTx: tx,
      txId,
      seq,
    });

    // Update for next iteration
    prevTx = txId;
    prevCid = item.cid;
  }

  return pending;
}
```

### 4. Parallel Upload Phase

```typescript
async function uploadParallel(
  pending: PendingTransaction[]
): Promise<Map<string, { success: boolean; error?: Error }>> {
  const results = new Map();

  // Upload all in parallel
  const uploads = pending.map(async (p) => {
    try {
      const response = await arweave.transactions.post(p.signedTx);
      if (response.status !== 200) {
        throw new Error(`Upload failed: ${response.status}`);
      }
      results.set(p.txId, { success: true });
    } catch (error) {
      results.set(p.txId, { success: false, error });
    }
  });

  await Promise.all(uploads);
  return results;
}
```

### 5. Finalization with Failure Handling

```typescript
async function finalizeBatch(
  env: Env,
  pending: PendingTransaction[],
  uploadResults: Map<string, UploadResult>,
  originalHead: ChainHead
): Promise<BatchResult> {
  const succeeded: PendingTransaction[] = [];
  const failed: { item: PendingTransaction; error: Error }[] = [];

  // Find the longest successful prefix
  // (chain is only valid up to the first failure)
  let lastSuccessfulSeq = originalHead.seq;
  let lastSuccessfulTx = originalHead.tx_id;
  let lastSuccessfulCid = originalHead.cid;

  for (const p of pending) {
    const result = uploadResults.get(p.txId);

    if (result?.success) {
      succeeded.push(p);
      lastSuccessfulSeq = p.seq;
      lastSuccessfulTx = p.txId;
      lastSuccessfulCid = p.queueItem.cid;
    } else {
      // First failure - everything after is invalid
      failed.push({ item: p, error: result?.error || new Error('Unknown') });

      // Mark all remaining as failed (chain broken)
      const remaining = pending.slice(pending.indexOf(p) + 1);
      for (const r of remaining) {
        failed.push({ item: r, error: new Error('Chain broken by earlier failure') });
      }
      break;
    }
  }

  // Update chain head to last successful TX
  if (lastSuccessfulTx !== originalHead.tx_id) {
    await updateChainHead(env, lastSuccessfulTx, lastSuccessfulCid, lastSuccessfulSeq);
  }

  // Update KV indexes for succeeded items
  for (const p of succeeded) {
    await updateKVIndex(env, p);
    await deleteFromQueue(env, p.queueItem.id);
  }

  // Re-queue failed items (they'll get new prev_tx on next run)
  for (const { item } of failed) {
    await markAsPending(env, item.queueItem.id);
  }

  return {
    succeeded,
    failed,
    newHead: lastSuccessfulTx ? {
      txId: lastSuccessfulTx,
      cid: lastSuccessfulCid,
      seq: lastSuccessfulSeq,
    } : null,
  };
}
```

---

## Failure Scenarios

### Scenario 1: All Uploads Succeed
```
Batch: [TX_1, TX_2, TX_3, TX_4, TX_5]
Results: [✓, ✓, ✓, ✓, ✓]
Action: Update head to TX_5, delete all from queue
Chain: ... → TX_1 → TX_2 → TX_3 → TX_4 → TX_5
```

### Scenario 2: Middle Upload Fails
```
Batch: [TX_1, TX_2, TX_3, TX_4, TX_5]
Results: [✓, ✓, ✗, ✓, ✓]
Action:
  - TX_1, TX_2: Succeeded, on Arweave ✓
  - TX_3: Failed, re-queue
  - TX_4, TX_5: Invalid (point to missing TX_3), re-queue
  - Update head to TX_2

Next run:
  - TX_3' gets prev_tx = TX_2 (correct!)
  - TX_4' gets prev_tx = TX_3'
  - Chain is repaired
```

### Scenario 3: First Upload Fails
```
Batch: [TX_1, TX_2, TX_3, TX_4, TX_5]
Results: [✗, ✓, ✓, ✓, ✓]
Action:
  - TX_1: Failed, re-queue
  - TX_2-5: Invalid, re-queue
  - Head unchanged

Next run: Entire batch re-signed with correct prev_tx
```

### Scenario 4: Worker Crashes Mid-Upload
```
Batch signed: [TX_1, TX_2, TX_3, TX_4, TX_5]
Uploads started, then crash after TX_1, TX_2 uploaded

Recovery (on next cron):
  - Items still in 'signing' state
  - Cleanup job marks them as 'pending' after timeout
  - TX_1, TX_2 are orphaned on Arweave (acceptable)
  - Next run re-signs from current head
```

---

## Database Schema Changes

### Migration: 0002_batch_support.sql

```sql
-- Add batch_id column for parallel batch locking
-- Groups items being processed in the same batch
ALTER TABLE attestation_queue ADD COLUMN batch_id TEXT;

-- Index for efficient batch queries
CREATE INDEX idx_attestation_queue_batch ON attestation_queue(batch_id)
WHERE batch_id IS NOT NULL;

-- Update status CHECK constraint to include 'signing' state
-- Note: SQLite doesn't support ALTER CONSTRAINT, so this is documentation
-- States: pending → signing → (deleted on success)
--                          ↓
--                       failed → pending (retry)
```

### Queue State Machine

| State | Meaning | Transitions To |
|-------|---------|----------------|
| `pending` | Ready to process | `signing` |
| `signing` | Locked by batch, being signed/uploaded | `deleted` (success) or `failed` |
| `failed` | Upload failed, awaiting retry | `pending` (via retry job) |

### Batch Tracking Table (Optional - Phase 2)

Only add if we need debugging visibility into batch history:

```sql
CREATE TABLE attestation_batches (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,  -- 'signing', 'uploading', 'completed', 'partial', 'failed'
  item_count INTEGER NOT NULL,
  succeeded_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  first_seq INTEGER,
  last_seq INTEGER,
  head_tx_before TEXT,
  head_tx_after TEXT
);
```

---

## Tuning Parameters

| Parameter | Recommended | Notes |
|-----------|-------------|-------|
| BATCH_SIZE | 50 | Balance between throughput and failure impact |
| UPLOAD_CONCURRENCY | 50 | Match batch size, or limit if Arweave rate-limits |
| SIGNING_TIMEOUT | 10s | Should be fast, but set limit |
| UPLOAD_TIMEOUT | 30s | Per-upload timeout |
| BATCH_TIMEOUT | 55s | Total time for batch processing |

---

## Monitoring & Observability

### Metrics to Track

1. **Batch metrics**
   - Batch size (actual vs target)
   - Sign time per batch
   - Upload time per batch
   - Success rate per batch

2. **Chain metrics**
   - Current seq number
   - Queue depth
   - Processing rate (items/min)

3. **Failure metrics**
   - Upload failure rate
   - Re-queue rate
   - Orphaned TX count

### Health Endpoint Updates

```typescript
// Add to health response
{
  chain: { seq, head_tx },
  queue: { pending, signing, uploading, failed },
  throughput: {
    last_batch_size: 50,
    last_batch_time_ms: 8500,
    items_per_minute: 352,
  }
}
```

---

## Implementation Phases

### Phase 0: Modularize Current Code
- [ ] Create `types.ts` - extract all interfaces
- [ ] Create `config.ts` - extract constants
- [ ] Create `arweave.ts` - extract client setup
- [ ] Create `chain/state.ts` - extract getChainHead, updateChainHead
- [ ] Create `queue/cleanup.ts` - extract retry/cleanup functions
- [ ] Create `queue/fetch.ts` - extract queue fetching
- [ ] Slim down `index.ts` to just entry point
- [ ] Verify existing sequential flow still works

### Phase 1: Core Parallel Upload
- [ ] Create `manifests/fetch.ts` - parallel R2 fetches
- [ ] Create `chain/signing.ts` - preSignBatch function
- [ ] Create `upload/parallel.ts` - uploadParallel function
- [ ] Create `queue/finalize.ts` - finalizeBatch with failure handling
- [ ] Create `process.ts` - orchestrate new batch flow
- [ ] Wire up to index.ts
- [ ] Test with small batches (10 items)

### Phase 2: Robustness
- [ ] Add batch_id column migration
- [ ] Update `queue/fetch.ts` for 'signing' state locking
- [ ] Implement crash recovery in `queue/cleanup.ts`
- [ ] Add batch tracking table (optional)
- [ ] Test failure scenarios (middle fail, first fail, crash)

### Phase 3: Optimization & Monitoring
- [ ] Tune BATCH_SIZE based on testing
- [ ] Add upload concurrency limiting if Arweave rate-limits
- [ ] Add metrics to health endpoint
- [ ] Load testing with 100+ items

### Phase 4: Production Hardening
- [ ] Load testing with 1000+ items
- [ ] Monitor for Arweave rate limits
- [ ] Document operational procedures
- [ ] Set up alerting (if needed)

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Arweave rate limiting | Add concurrency limit, exponential backoff |
| Orphaned TXs on failure | Acceptable - chain remains valid, just wasted AR |
| Memory pressure (large batches) | Limit batch size, stream manifests |
| Long signing time | Set timeout, fall back to smaller batch |
| Partial batch success | Re-queue failed items, chain self-heals |

---

## Questions to Resolve

1. **Batch size**: Start with 50, tune based on testing?
2. **Concurrency limit**: Unlimited or cap at N parallel uploads?
3. **Batch tracking table**: Needed for debugging or overkill?
4. **Orphan cleanup**: Log orphaned TXs or ignore them?

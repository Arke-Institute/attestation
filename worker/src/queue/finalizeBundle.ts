/**
 * Bundle finalization - handle success/failure for bundled uploads
 *
 * With bundling, the entire batch either succeeds or fails together.
 * This simplifies the logic compared to individual uploads.
 *
 * KV writes are chunked with retry logic to avoid 429 rate limit errors.
 */

import type { Env, PendingDataItem, ChainHead, AttestationRecord } from "../types";
import { updateChainHead, CHAIN_KEY_PROD } from "../chain/state";

// KV write configuration
const KV_BATCH_SIZE = 50; // Max concurrent KV writes per batch
const KV_BATCH_DELAY_MS = 100; // Delay between batches
const KV_MAX_RETRIES = 3; // Max retries per write on 429

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * KV put with retry on 429 errors
 */
async function kvPutWithRetry(
  kv: KVNamespace,
  key: string,
  value: string,
  retries = KV_MAX_RETRIES
): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await kv.put(key, value);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("429") && attempt < retries - 1) {
        const backoff = KV_BATCH_DELAY_MS * Math.pow(2, attempt);
        console.log(`[KV] Rate limited on ${key}, retrying in ${backoff}ms (attempt ${attempt + 1}/${retries})`);
        await sleep(backoff);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Execute KV writes in chunked batches with retry logic
 */
async function executeKvWritesChunked(
  kv: KVNamespace,
  writes: Array<{ key: string; value: string }>
): Promise<void> {
  for (let i = 0; i < writes.length; i += KV_BATCH_SIZE) {
    const batch = writes.slice(i, i + KV_BATCH_SIZE);
    await Promise.all(batch.map((w) => kvPutWithRetry(kv, w.key, w.value)));

    // Delay between batches (skip after last batch)
    if (i + KV_BATCH_SIZE < writes.length) {
      await sleep(KV_BATCH_DELAY_MS);
    }
  }
}

/**
 * Finalize a successful bundle upload
 *
 * All items in the bundle succeeded, so we:
 * 1. Update KV indexes for all items (with bundled=true)
 * 2. Delete all items from queue
 * 3. Update chain head to last item
 *
 * @param env - Worker environment
 * @param pending - All pending DataItems that were uploaded
 * @param originalHead - Chain head before this batch
 * @param options - Optional settings (chainKey for test isolation, skipQueue to not delete from queue)
 */
export async function finalizeBundleSuccess(
  env: Env,
  pending: PendingDataItem[],
  originalHead: ChainHead,
  options: { chainKey?: string; skipQueue?: boolean } = {}
): Promise<void> {
  const { chainKey = CHAIN_KEY_PROD, skipQueue = false } = options;
  if (pending.length === 0) return;

  // The last item becomes the new chain head
  const lastItem = pending[pending.length - 1];

  // Update chain head (using specified chain key for test isolation)
  await updateChainHead(env, lastItem.txId, lastItem.queueItem.cid, lastItem.seq, chainKey);

  // Prepare KV writes and queue deletes
  const kvWrites: Array<{ key: string; value: string }> = [];
  const queueIds: number[] = [];

  for (const p of pending) {
    const kvData: AttestationRecord = {
      cid: p.queueItem.cid,
      tx: p.txId,
      seq: p.seq,
      ts: new Date(p.queueItem.ts).getTime(),
      bundled: true,
    };

    const kvDataStr = JSON.stringify(kvData);

    // Queue writes for both version-specific and latest keys
    kvWrites.push({ key: `attest:${p.queueItem.entity_id}:${p.manifest.ver}`, value: kvDataStr });
    kvWrites.push({ key: `attest:${p.queueItem.entity_id}:latest`, value: kvDataStr });

    queueIds.push(p.queueItem.id);

    console.log(
      `[ATTESTATION] ✓ seq=${p.seq} ${p.queueItem.entity_id}:v${p.manifest.ver} -> ${p.txId} (bundled)`
    );
  }

  // Execute KV writes in chunked batches with retry logic
  await executeKvWritesChunked(env.ATTESTATION_INDEX, kvWrites);

  // Batch delete from queue (skip for test mode)
  // Chunk to stay under D1's SQL parameter limit
  if (!skipQueue && queueIds.length > 0) {
    const CHUNK_SIZE = 50;
    for (let i = 0; i < queueIds.length; i += CHUNK_SIZE) {
      const chunk = queueIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      await env.D1_PROD
        .prepare(`DELETE FROM attestation_queue WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .run();
    }
  }
}

/**
 * Handle bundle upload failure
 *
 * Re-queue all items for retry. They'll get new prev_tx values next run.
 *
 * @param env - Worker environment
 * @param pending - All pending DataItems that failed
 * @param error - The error that occurred
 */
export async function finalizeBundleFailure(
  env: Env,
  pending: PendingDataItem[],
  error: Error
): Promise<void> {
  const now = new Date().toISOString();
  const errorMessage = error.message;

  for (const p of pending) {
    await env.D1_PROD
      .prepare(
        `UPDATE attestation_queue
         SET status = 'pending',
             retry_count = retry_count + 1,
             error_message = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(errorMessage, now, p.queueItem.id)
      .run();

    console.error(`[ATTESTATION] ✗ ${p.queueItem.entity_id}:${p.queueItem.cid}: ${errorMessage}`);
  }
}

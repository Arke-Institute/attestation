/**
 * Main queue processing orchestration
 *
 * Implements parallel pre-signing for high throughput:
 * 1. Fetch batch of pending items
 * 2. Mark as 'signing' (lock)
 * 3. Fetch manifests in parallel
 * 4. Pre-sign all transactions sequentially (fast, ~1-5ms each)
 * 5. Upload all transactions in parallel (slow part parallelized)
 * 6. Finalize: update head, KV indexes, re-queue failures
 */

import type { Env, ProcessResult, QueueItem } from "./types";
import { CONFIG } from "./config";
import { getChainHead } from "./chain/state";
import { preSignBatch } from "./chain/signing";
import { fetchPendingBatch, markBatchAsSigning } from "./queue/fetch";
import { fetchManifestsParallel } from "./manifests/fetch";
import { uploadParallel } from "./upload/parallel";
import { finalizeBatch } from "./queue/finalize";

/**
 * Process the attestation queue using parallel pre-signing
 */
export async function processQueue(env: Env): Promise<ProcessResult> {
  const startTime = Date.now();

  // 1. Fetch batch of pending items
  const fetchStart = Date.now();
  const items = await fetchPendingBatch(env, CONFIG.BATCH_SIZE);

  if (items.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, duration: Date.now() - startTime };
  }

  // 2. Mark all as 'signing' (prevent other workers from picking them up)
  await markBatchAsSigning(env, items.map((i) => i.id));

  // 3. Fetch manifests in parallel
  const manifests = await fetchManifestsParallel(env, items);
  const fetchTime = Date.now() - fetchStart;

  // Filter to items that have manifests
  const itemsWithManifests = items.filter((i) => manifests.has(i.cid));
  const itemsWithoutManifests = items.filter((i) => !manifests.has(i.cid));

  // Mark items without manifests as failed
  await markItemsAsFailed(env, itemsWithoutManifests, "Manifest not found in R2");

  if (itemsWithManifests.length === 0) {
    return {
      processed: items.length,
      succeeded: 0,
      failed: items.length,
      duration: Date.now() - startTime,
    };
  }

  // 4. Get current chain head
  const head = await getChainHead(env);

  // 5. Pre-sign all transactions sequentially (fast)
  const signStart = Date.now();
  const pending = await preSignBatch(env, itemsWithManifests, manifests, head);
  const signTime = Date.now() - signStart;

  if (pending.length === 0) {
    return {
      processed: items.length,
      succeeded: 0,
      failed: items.length,
      duration: Date.now() - startTime,
    };
  }

  // 6. Upload all transactions in parallel (slow part parallelized)
  const uploadStart = Date.now();
  const uploadResults = await uploadParallel(pending);
  const uploadTime = Date.now() - uploadStart;

  // 7. Finalize: update head, KV indexes, re-queue failures
  const finalizeStart = Date.now();
  const result = await finalizeBatch(env, pending, uploadResults, head);
  const finalizeTime = Date.now() - finalizeStart;

  const duration = Date.now() - startTime;
  const succeeded = result.succeeded.length;
  const failed = result.failed.length + itemsWithoutManifests.length;

  console.log(
    `[ATTESTATION] Batch: ${items.length} items, ${succeeded} succeeded, ${failed} failed in ${duration}ms ` +
      `(fetch=${fetchTime}ms, sign=${signTime}ms, upload=${uploadTime}ms, finalize=${finalizeTime}ms)`
  );

  return {
    processed: items.length,
    succeeded,
    failed,
    duration,
  };
}

/**
 * Mark items as failed (for items without manifests)
 */
async function markItemsAsFailed(
  env: Env,
  items: QueueItem[],
  errorMessage: string
): Promise<void> {
  const now = new Date().toISOString();

  for (const item of items) {
    await env.D1_PROD
      .prepare(
        `UPDATE attestation_queue
         SET status = 'failed',
             retry_count = retry_count + 1,
             error_message = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(errorMessage, now, item.id)
      .run();

    console.error(`[ATTESTATION] ✗ ${item.entity_id}:${item.cid}: ${errorMessage}`);
  }
}

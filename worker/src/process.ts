/**
 * Main queue processing orchestration
 *
 * Implements ANS-104 bundling for cost-efficient uploads:
 * 1. Fetch batch of pending items
 * 2. Check if size/time threshold met for bundling
 * 3. Sign as DataItems (IDs known immediately)
 * 4. Bundle and upload as single L1 transaction
 * 5. Finalize: update head, KV indexes, delete from queue
 *
 * Falls back to legacy parallel L1 uploads if bundling disabled.
 */

import type { Env, ProcessResult, QueueItem, PendingDataItem } from "./types";
import { CONFIG } from "./config";
import { getChainHead } from "./chain/state";
import { signDataItemBatch, extractDataItems } from "./chain/signDataItems";
import { fetchPendingBatch, markBatchAsSigning } from "./queue/fetch";
import { fetchManifestsParallel } from "./manifests/fetch";
import { uploadBundle, calculateBundleSize } from "./upload/bundle";
import { finalizeBundleSuccess, finalizeBundleFailure } from "./queue/finalizeBundle";

// Legacy imports for fallback
import { preSignBatch } from "./chain/signing";
import { uploadParallel } from "./upload/parallel";
import { finalizeBatch } from "./queue/finalize";

/**
 * Process the attestation queue using ANS-104 bundling
 */
export async function processQueue(env: Env): Promise<ProcessResult> {
  const startTime = Date.now();

  // 1. Fetch batch of pending items
  const items = await fetchPendingBatch(env, CONFIG.BATCH_SIZE);

  if (items.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, duration: Date.now() - startTime };
  }

  // Check if we should use bundling
  if (CONFIG.USE_BUNDLING) {
    return processWithBundling(env, items, startTime);
  } else {
    return processLegacy(env, items, startTime);
  }
}

/**
 * Process queue with ANS-104 bundling
 */
async function processWithBundling(
  env: Env,
  items: QueueItem[],
  startTime: number
): Promise<ProcessResult> {
  // 2. Mark all as 'signing' (prevent other workers from picking them up)
  await markBatchAsSigning(env, items.map((i) => i.id));

  // 3. Fetch manifests in parallel
  const manifests = await fetchManifestsParallel(env, items);

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

  // 5. Sign all items as DataItems
  const signStart = Date.now();
  const pending = await signDataItemBatch(env, itemsWithManifests, manifests, head);
  const signTime = Date.now() - signStart;

  if (pending.length === 0) {
    return {
      processed: items.length,
      succeeded: 0,
      failed: items.length,
      duration: Date.now() - startTime,
    };
  }

  // 6. Check if we should upload now (size or time threshold)
  const dataItems = extractDataItems(pending);
  const bundleSize = calculateBundleSize(dataItems);

  // Check time threshold - use oldest item from the batch we fetched
  // (can't use getOldestPendingTimestamp because items are already marked 'signing')
  // Handle both ISO format (with Z) and SQLite format (without Z)
  const oldestItemTimestamp = Math.min(
    ...pending.map((p) => {
      const ts = p.queueItem.created_at;
      return new Date(ts.endsWith("Z") ? ts : ts + "Z").getTime();
    })
  );
  const timeWaiting = Date.now() - oldestItemTimestamp;
  const timeThresholdMet = timeWaiting >= CONFIG.BUNDLE_TIME_THRESHOLD_MS;

  const sizeThresholdMet = bundleSize >= CONFIG.BUNDLE_SIZE_THRESHOLD;

  if (!sizeThresholdMet && !timeThresholdMet) {
    // Not ready to upload yet - re-queue items as pending
    console.log(
      `[ATTESTATION] Bundle not ready: ${bundleSize} bytes (need ${CONFIG.BUNDLE_SIZE_THRESHOLD}), ` +
        `${Math.round(timeWaiting / 1000)}s waiting (need ${CONFIG.BUNDLE_TIME_THRESHOLD_MS / 1000}s)`
    );
    await revertToSigningState(env, pending);
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      duration: Date.now() - startTime,
    };
  }

  // 7. Bundle and upload
  const uploadStart = Date.now();
  let uploadSuccess = false;
  let uploadError: Error | null = null;

  try {
    const wallet = JSON.parse(env.ARWEAVE_WALLET);
    const result = await uploadBundle(dataItems, wallet);
    uploadSuccess = true;
    console.log(
      `[ATTESTATION] Bundle uploaded: ${result.bundleTxId} (${pending.length} items, ${bundleSize} bytes)`
    );
  } catch (error) {
    uploadError = error instanceof Error ? error : new Error(String(error));
    console.error(`[ATTESTATION] Bundle upload failed: ${uploadError.message}`);
  }

  const uploadTime = Date.now() - uploadStart;

  // 8. Finalize
  const finalizeStart = Date.now();

  if (uploadSuccess) {
    await finalizeBundleSuccess(env, pending, head);
  } else {
    await finalizeBundleFailure(env, pending, uploadError!);
  }

  const finalizeTime = Date.now() - finalizeStart;
  const duration = Date.now() - startTime;

  const succeeded = uploadSuccess ? pending.length : 0;
  const failed = uploadSuccess ? itemsWithoutManifests.length : pending.length + itemsWithoutManifests.length;

  console.log(
    `[ATTESTATION] Batch: ${items.length} items, ${succeeded} succeeded, ${failed} failed in ${duration}ms ` +
      `(sign=${signTime}ms, upload=${uploadTime}ms, finalize=${finalizeTime}ms, bundleSize=${bundleSize})`
  );

  return {
    processed: items.length,
    succeeded,
    failed,
    duration,
  };
}

/**
 * Legacy processing with parallel L1 uploads (fallback)
 */
async function processLegacy(
  env: Env,
  items: QueueItem[],
  startTime: number
): Promise<ProcessResult> {
  // Mark all as 'signing'
  await markBatchAsSigning(env, items.map((i) => i.id));

  // Fetch manifests in parallel
  const manifests = await fetchManifestsParallel(env, items);

  // Filter to items that have manifests
  const itemsWithManifests = items.filter((i) => manifests.has(i.cid));
  const itemsWithoutManifests = items.filter((i) => !manifests.has(i.cid));

  await markItemsAsFailed(env, itemsWithoutManifests, "Manifest not found in R2");

  if (itemsWithManifests.length === 0) {
    return {
      processed: items.length,
      succeeded: 0,
      failed: items.length,
      duration: Date.now() - startTime,
    };
  }

  // Get chain head and pre-sign
  const head = await getChainHead(env);
  const pending = await preSignBatch(env, itemsWithManifests, manifests, head);

  if (pending.length === 0) {
    return {
      processed: items.length,
      succeeded: 0,
      failed: items.length,
      duration: Date.now() - startTime,
    };
  }

  // Upload in parallel
  const uploadResults = await uploadParallel(pending);

  // Finalize
  const result = await finalizeBatch(env, pending, uploadResults, head);

  const duration = Date.now() - startTime;
  const succeeded = result.succeeded.length;
  const failed = result.failed.length + itemsWithoutManifests.length;

  console.log(
    `[ATTESTATION] Legacy batch: ${items.length} items, ${succeeded} succeeded, ${failed} failed in ${duration}ms`
  );

  return {
    processed: items.length,
    succeeded,
    failed,
    duration,
  };
}

/**
 * Revert items from 'signing' state back to 'pending'
 * Used when bundle threshold not met
 */
async function revertToSigningState(env: Env, pending: PendingDataItem[]): Promise<void> {
  const now = new Date().toISOString();
  const ids = pending.map((p) => p.queueItem.id);

  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    await env.D1_PROD
      .prepare(
        `UPDATE attestation_queue SET status = 'pending', updated_at = ? WHERE id IN (${placeholders})`
      )
      .bind(now, ...ids)
      .run();
  }
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

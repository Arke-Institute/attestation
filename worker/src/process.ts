/**
 * Main queue processing orchestration
 *
 * Primary: Turbo SDK uploads (fast, reliable, free for small items)
 * 1. Fetch batch of pending items
 * 2. Upload each via Turbo SDK (parallel)
 * 3. Finalize: update head, KV indexes, delete from queue
 *
 * Fallback: ANS-104 bundling (deprecated - gateways no longer unbundle)
 * Legacy: Parallel L1 uploads (expensive, slow)
 */

import type { Env, ProcessResult, QueueItem, PendingDataItem, AttestationPayload, ChainHead, AttestationRecord, Manifest } from "./types";
import { CONFIG } from "./config";
import { getChainHead, updateChainHead, CHAIN_KEY_PROD } from "./chain/state";
import { fetchPendingBatch, markBatchAsSigning } from "./queue/fetch";
import { fetchManifestsParallel } from "./manifests/fetch";
import { checkWalletBalance } from "./balance/check";
import { sendLowBalanceAlert } from "./balance/alerts";

// Turbo imports (primary)
import { signItemsSequentially, uploadSignedBatchViaTurbo, type TurboUploadItem } from "./turbo";

// Bundle imports (fallback - deprecated)
import { signDataItemBatch, extractDataItems } from "./chain/signDataItems";
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

  // 0. Check wallet balance - skip processing if critically low
  try {
    const balance = await checkWalletBalance(env);

    if (balance.isCritical) {
      console.log(
        `[ATTESTATION] Skipping processing - wallet balance critically low: ${balance.balanceAR} AR`
      );
      await sendLowBalanceAlert(env, balance);
      return { processed: 0, succeeded: 0, failed: 0, duration: Date.now() - startTime };
    }

    if (balance.isLow) {
      console.warn(`[ATTESTATION] Wallet balance low: ${balance.balanceAR} AR - continuing but alert sent`);
      await sendLowBalanceAlert(env, balance);
    }
  } catch (error) {
    // Don't block processing if balance check fails - just log and continue
    console.error(`[ATTESTATION] Balance check failed: ${error}`);
  }

  // 1. Fetch batch of pending items
  const items = await fetchPendingBatch(env, CONFIG.BATCH_SIZE);

  if (items.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, duration: Date.now() - startTime };
  }

  // Check which upload method to use
  if (CONFIG.USE_TURBO) {
    return processWithTurbo(env, items, startTime);
  } else if (CONFIG.USE_BUNDLING) {
    return processWithBundling(env, items, startTime);
  } else {
    return processLegacy(env, items, startTime);
  }
}

/**
 * Process queue with Turbo SDK uploads
 *
 * Uploads each item individually via Turbo SDK with high concurrency.
 * Much faster than bundling (no threshold wait) and more reliable
 * (Turbo handles bundling server-side).
 */
async function processWithTurbo(
  env: Env,
  items: QueueItem[],
  startTime: number
): Promise<ProcessResult> {
  // 1. Mark all as 'signing' (prevent other workers from picking them up)
  await markBatchAsSigning(env, items.map((i) => i.id));

  // 2. Fetch manifests in parallel
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

  // 3. Get current chain head
  const head = await getChainHead(env);

  // 4. Sign items sequentially (maintains chain integrity with proper prev_tx links)
  const signStart = Date.now();
  const signedItems = await signItemsSequentially(env, itemsWithManifests, manifests, head);
  const signTime = Date.now() - signStart;

  // 5. Upload signed items in parallel via Turbo
  const uploadStart = Date.now();
  const batchResult = await uploadSignedBatchViaTurbo(signedItems);
  const uploadTime = Date.now() - uploadStart;

  // 6. Finalize results
  const finalizeStart = Date.now();

  // Process successful uploads
  if (batchResult.succeeded.length > 0) {
    await finalizeTurboSuccess(env, batchResult.succeeded, head);
  }

  // Process failed uploads
  if (batchResult.failed.length > 0) {
    await finalizeTurboFailure(env, batchResult.failed);
  }

  const finalizeTime = Date.now() - finalizeStart;
  const duration = Date.now() - startTime;

  const succeeded = batchResult.succeeded.length;
  const failed = batchResult.failed.length + itemsWithoutManifests.length;

  console.log(
    `[ATTESTATION] Turbo batch: ${items.length} items, ${succeeded} succeeded, ${failed} failed in ${duration}ms ` +
      `(sign=${signTime}ms, upload=${uploadTime}ms, finalize=${finalizeTime}ms, rate=${(succeeded / (uploadTime / 1000)).toFixed(1)}/s)`
  );

  return {
    processed: items.length,
    succeeded,
    failed,
    duration,
  };
}


// KV write configuration (shared with bundle finalization)
const KV_BATCH_SIZE = 50;
const KV_BATCH_DELAY_MS = 100;
const KV_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        await sleep(backoff);
        continue;
      }
      throw error;
    }
  }
}

async function executeKvWritesChunked(
  kv: KVNamespace,
  writes: Array<{ key: string; value: string }>
): Promise<void> {
  for (let i = 0; i < writes.length; i += KV_BATCH_SIZE) {
    const batch = writes.slice(i, i + KV_BATCH_SIZE);
    await Promise.all(batch.map((w) => kvPutWithRetry(kv, w.key, w.value)));
    if (i + KV_BATCH_SIZE < writes.length) {
      await sleep(KV_BATCH_DELAY_MS);
    }
  }
}

/**
 * Finalize successful Turbo uploads
 */
async function finalizeTurboSuccess(
  env: Env,
  succeeded: Array<{ item: TurboUploadItem; txId?: string }>,
  originalHead: ChainHead
): Promise<void> {
  if (succeeded.length === 0) return;

  // The last item becomes the new chain head
  const lastItem = succeeded[succeeded.length - 1];

  // Update chain head
  await updateChainHead(
    env,
    lastItem.txId!,
    lastItem.item.queueItem.cid,
    lastItem.item.seq,
    CHAIN_KEY_PROD
  );

  // Prepare KV writes and queue deletes
  const kvWrites: Array<{ key: string; value: string }> = [];
  const queueIds: number[] = [];

  for (const result of succeeded) {
    const item = result.item;
    const kvData: AttestationRecord = {
      cid: item.queueItem.cid,
      tx: result.txId!,
      seq: item.seq,
      ts: new Date(item.queueItem.ts).getTime(),
      // Note: Turbo uploads are bundled server-side, so they're effectively bundled
    };

    const kvDataStr = JSON.stringify(kvData);

    // Queue writes for both version-specific and latest keys
    kvWrites.push({ key: `attest:${item.queueItem.entity_id}:${item.manifest.ver}`, value: kvDataStr });
    kvWrites.push({ key: `attest:${item.queueItem.entity_id}:latest`, value: kvDataStr });

    queueIds.push(item.queueItem.id);

    console.log(
      `[ATTESTATION] ✓ seq=${item.seq} ${item.queueItem.entity_id}:v${item.manifest.ver} -> ${result.txId} (turbo)`
    );
  }

  // Execute KV writes in chunked batches
  await executeKvWritesChunked(env.ATTESTATION_INDEX, kvWrites);

  // Batch delete from queue
  if (queueIds.length > 0) {
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
 * Handle failed Turbo uploads - re-queue for retry
 */
async function finalizeTurboFailure(
  env: Env,
  failed: Array<{ item: TurboUploadItem; error?: string }>
): Promise<void> {
  const now = new Date().toISOString();

  for (const result of failed) {
    const item = result.item;
    const errorMessage = result.error || "Turbo upload failed";

    await env.D1_PROD
      .prepare(
        `UPDATE attestation_queue
         SET status = 'pending',
             retry_count = retry_count + 1,
             error_message = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(errorMessage, now, item.queueItem.id)
      .run();

    console.error(`[ATTESTATION] ✗ ${item.queueItem.entity_id}:${item.queueItem.cid}: ${errorMessage}`);
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
  let itemsWithManifests = items.filter((i) => manifests.has(i.cid));
  const itemsWithoutManifests = items.filter((i) => !manifests.has(i.cid));

  // 3.5. Size-based batch limiting
  // Large manifests (450KB+) can create 40MB+ bundles that fail to seed
  // Limit batch to MAX_BUNDLE_SIZE_BYTES to prevent seeding failures
  let accumulatedSize = 0;
  const itemsWithinSizeLimit: typeof itemsWithManifests = [];
  const itemsExceedingSizeLimit: typeof itemsWithManifests = [];

  for (const item of itemsWithManifests) {
    const manifest = manifests.get(item.cid);
    const manifestSize = manifest ? JSON.stringify(manifest).length : 0;

    if (accumulatedSize + manifestSize <= CONFIG.MAX_BUNDLE_SIZE_BYTES) {
      itemsWithinSizeLimit.push(item);
      accumulatedSize += manifestSize;
    } else {
      itemsExceedingSizeLimit.push(item);
    }
  }

  // If we had to split due to size, revert excess items to pending
  if (itemsExceedingSizeLimit.length > 0) {
    console.log(
      `[ATTESTATION] Size limit: processing ${itemsWithinSizeLimit.length} items (${Math.round(accumulatedSize / 1024)}KB), ` +
        `deferring ${itemsExceedingSizeLimit.length} items to next cycle`
    );
    await revertItemsToPending(env, itemsExceedingSizeLimit);
    itemsWithManifests = itemsWithinSizeLimit;
  }

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
  let bundleTxId: string | null = null;

  try {
    const wallet = JSON.parse(env.ARWEAVE_WALLET);
    const result = await uploadBundle(dataItems, wallet);
    uploadSuccess = true;
    bundleTxId = result.bundleTxId;
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

  if (uploadSuccess && bundleTxId) {
    await finalizeBundleSuccess(env, pending, head, bundleTxId);
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

  // Chunk to stay under D1's SQL parameter limit
  const CHUNK_SIZE = 50;
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    await env.D1_PROD
      .prepare(
        `UPDATE attestation_queue SET status = 'pending', updated_at = ? WHERE id IN (${placeholders})`
      )
      .bind(now, ...chunk)
      .run();
  }
}

/**
 * Revert queue items back to 'pending' state
 * Used when batch exceeds size limit
 */
async function revertItemsToPending(env: Env, items: QueueItem[]): Promise<void> {
  if (items.length === 0) return;

  const now = new Date().toISOString();
  const ids = items.map((item) => item.id);

  // Chunk to stay under D1's SQL parameter limit
  const CHUNK_SIZE = 50;
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    await env.D1_PROD
      .prepare(
        `UPDATE attestation_queue SET status = 'pending', updated_at = ? WHERE id IN (${placeholders})`
      )
      .bind(now, ...chunk)
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

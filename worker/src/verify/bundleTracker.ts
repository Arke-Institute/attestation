/**
 * Bundle tracking and seeding verification
 *
 * Tracks uploaded bundles and verifies they are seeded to Arweave gateways.
 * If a bundle fails to seed, re-queues affected entities for retry.
 */

import type { Env, PendingBundle, PendingDataItem, BundleVerifyResult, TrackedItem } from "../types";
import { CONFIG } from "../config";
import { sendSeedingFailureAlert } from "./alerts";

// KV key for storing pending bundles
const PENDING_BUNDLES_KEY = "verify:pending_bundles";

// Chunk size for D1 operations to avoid SQL parameter limits
const D1_CHUNK_SIZE = 25;

/**
 * Track a bundle for later seeding verification
 * Called from finalizeBundleSuccess after upload completes
 */
export async function trackBundle(
  env: Env,
  bundleTxId: string,
  pending: PendingDataItem[]
): Promise<void> {
  // Build items array (preserves all items including same entity with different CIDs)
  const items: TrackedItem[] = pending.map((p) => ({
    entityId: p.queueItem.entity_id,
    cid: p.queueItem.cid,
  }));

  // Also build legacy entityCids for backward compatibility (last CID wins)
  const entityCids: Record<string, string> = {};
  for (const p of pending) {
    entityCids[p.queueItem.entity_id] = p.queueItem.cid;
  }

  const bundle: PendingBundle = {
    bundleTxId,
    entityCids, // Keep for backward compat
    items, // New: all items preserved
    itemCount: pending.length,
    uploadedAt: Date.now(),
    checkCount: 0,
  };

  // Get existing bundles and append
  const bundles = await getPendingBundles(env);
  bundles.push(bundle);

  // Prune old records while saving
  await savePendingBundles(env, bundles);

  console.log(`[VERIFY] Tracking bundle ${bundleTxId} with ${pending.length} items for seeding verification`);
}

/**
 * Get all pending bundles from KV (exported for testing)
 */
export async function getPendingBundles(env: Env): Promise<PendingBundle[]> {
  const data = await env.ATTESTATION_INDEX.get(PENDING_BUNDLES_KEY);
  if (!data) return [];

  try {
    return JSON.parse(data) as PendingBundle[];
  } catch {
    console.error("[VERIFY] Failed to parse pending bundles from KV");
    return [];
  }
}

/**
 * Save pending bundles to KV, pruning records older than retention period
 */
async function savePendingBundles(env: Env, bundles: PendingBundle[]): Promise<void> {
  const now = Date.now();

  // Filter out bundles older than retention period
  const retained = bundles.filter(
    (b) => now - b.uploadedAt < CONFIG.BUNDLE_RETENTION_MS
  );

  await env.ATTESTATION_INDEX.put(PENDING_BUNDLES_KEY, JSON.stringify(retained));
}

/**
 * Check if bundle is confirmed on Arweave via /tx/{txId}/status
 * This is much faster and more reliable than checking /raw/{txId}
 * Returns true if TX has at least 1 confirmation
 */
async function checkBundleSeeded(bundleTxId: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.BUNDLE_VERIFY_TIMEOUT_MS
    );

    const response = await fetch(`https://arweave.net/tx/${bundleTxId}/status`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return false; // 404 = TX not found/not confirmed yet
    }

    const text = await response.text();
    // Non-existent TXs return "Not Found." text, not JSON
    if (text === "Not Found.") {
      return false;
    }

    try {
      const status = JSON.parse(text) as { number_of_confirmations?: number };
      // Consider seeded if it has at least 1 confirmation
      return (status.number_of_confirmations ?? 0) > 0;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Re-queue entities from a failed bundle
 * Uses chunked inserts to avoid D1 SQL parameter limits
 * Supports both new items array and legacy entityCids format
 */
async function requeueEntities(env: Env, bundle: PendingBundle): Promise<number> {
  // Use items array if available, fall back to legacy entityCids
  const itemsToRequeue: TrackedItem[] = bundle.items ??
    Object.entries(bundle.entityCids).map(([entityId, cid]) => ({ entityId, cid }));

  let requeued = 0;

  for (let i = 0; i < itemsToRequeue.length; i += D1_CHUNK_SIZE) {
    const chunk = itemsToRequeue.slice(i, i + D1_CHUNK_SIZE);
    const now = new Date().toISOString();

    for (const { entityId, cid } of chunk) {
      // Check if already in queue (avoid duplicates)
      const existing = await env.D1_PROD
        .prepare("SELECT id FROM attestation_queue WHERE entity_id = ? AND cid = ?")
        .bind(entityId, cid)
        .first();

      if (!existing) {
        await env.D1_PROD
          .prepare(
            `INSERT INTO attestation_queue
             (entity_id, cid, op, vis, ts, status, created_at, updated_at, retry_count)
             VALUES (?, ?, 'U', 'pub', ?, 'pending', ?, ?, 0)`
          )
          .bind(entityId, cid, now, now, now)
          .run();
        requeued++;
      }
    }
  }

  return requeued;
}

/**
 * Main verification function - called every cron cycle
 */
export async function verifyPendingBundles(env: Env): Promise<BundleVerifyResult> {
  const bundles = await getPendingBundles(env);
  const now = Date.now();
  const result: BundleVerifyResult = {
    checked: 0,
    verified: 0,
    failed: 0,
    pending: 0,
    requeuedEntities: 0,
  };

  if (bundles.length === 0) {
    return result;
  }

  const updatedBundles: PendingBundle[] = [];

  for (const bundle of bundles) {
    // Skip already processed bundles (keep for retention period)
    if (bundle.verified || bundle.failed) {
      updatedBundles.push(bundle);
      continue;
    }

    // Skip if not past grace period yet
    if (now - bundle.uploadedAt < CONFIG.BUNDLE_SEED_GRACE_PERIOD_MS) {
      updatedBundles.push(bundle);
      result.pending++;
      continue;
    }

    // Check if bundle is seeded
    result.checked++;
    const isSeeded = await checkBundleSeeded(bundle.bundleTxId);

    if (isSeeded) {
      // Bundle verified successfully
      bundle.verified = true;
      bundle.verifiedAt = now;
      result.verified++;
      console.log(`[VERIFY] Bundle ${bundle.bundleTxId} verified seeded`);
    } else if (now - bundle.uploadedAt > CONFIG.BUNDLE_SEED_TIMEOUT_MS) {
      // Past timeout - mark as failed and re-queue entities
      bundle.failed = true;
      bundle.failedAt = now;
      result.failed++;

      console.error(
        `[VERIFY] Bundle ${bundle.bundleTxId} failed to seed after ${Math.round(
          (now - bundle.uploadedAt) / 60000
        )} minutes, re-queuing ${bundle.itemCount} entities`
      );

      const requeued = await requeueEntities(env, bundle);
      result.requeuedEntities += requeued;

      // Send alert
      await sendSeedingFailureAlert(env, bundle, requeued);
    } else {
      // Still within timeout window, keep checking
      bundle.checkCount++;
      result.pending++;
    }

    updatedBundles.push(bundle);
  }

  await savePendingBundles(env, updatedBundles);

  if (result.checked > 0) {
    console.log(
      `[VERIFY] Checked ${result.checked} bundles: ` +
        `${result.verified} verified, ${result.failed} failed, ${result.pending} pending`
    );
  }

  return result;
}

/**
 * Add a test bundle record for verification testing
 * This allows testing the verification logic without a real upload
 */
export async function addTestBundle(
  env: Env,
  bundleTxId: string,
  options: { itemCount?: number; ageMinutes?: number } = {}
): Promise<PendingBundle> {
  const { itemCount = 1, ageMinutes = 0 } = options;

  // Create test items array
  const items: TrackedItem[] = [];
  const entityCids: Record<string, string> = {};
  for (let i = 0; i < itemCount; i++) {
    const entityId = `test_entity_${i}`;
    const cid = `test_cid_${i}`;
    items.push({ entityId, cid });
    entityCids[entityId] = cid;
  }

  const bundle: PendingBundle = {
    bundleTxId,
    entityCids, // Legacy compat
    items, // New format
    itemCount,
    uploadedAt: Date.now() - ageMinutes * 60 * 1000,
    checkCount: 0,
  };

  const bundles = await getPendingBundles(env);
  bundles.push(bundle);
  await savePendingBundles(env, bundles);

  return bundle;
}

/**
 * Check if a specific bundle is seeded (exported for testing)
 */
export async function checkBundleSeededPublic(bundleTxId: string): Promise<boolean> {
  return checkBundleSeeded(bundleTxId);
}

/**
 * Get verification stats for health endpoint
 */
export async function getVerificationStats(
  env: Env
): Promise<{ pendingBundles: number; verifiedLast24h: number; failedLast24h: number }> {
  const bundles = await getPendingBundles(env);

  return {
    pendingBundles: bundles.filter((b) => !b.verified && !b.failed).length,
    verifiedLast24h: bundles.filter((b) => b.verified).length,
    failedLast24h: bundles.filter((b) => b.failed).length,
  };
}

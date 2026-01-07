/**
 * Queue cleanup and retry operations
 */

import type { Env, QueueItem } from "../types";
import { CONFIG } from "../config";

/**
 * Retry failed items that haven't exceeded max retries
 * Runs daily at 4 AM
 */
export async function retryFailedItems(env: Env): Promise<void> {
  console.log("[ATTESTATION] Running retry job");

  const db = env.D1_PROD;
  const now = new Date().toISOString();

  // Reset failed items with retries remaining
  const result = await db
    .prepare(
      `UPDATE attestation_queue
       SET status = 'pending', updated_at = ?
       WHERE status = 'failed' AND retry_count < ?`
    )
    .bind(now, CONFIG.MAX_RETRIES)
    .run();

  console.log(`[ATTESTATION] Reset ${result.meta.changes} failed items`);

  // Log abandoned items (exceeded max retries)
  const abandoned = await db
    .prepare(
      `SELECT entity_id, cid, error_message, retry_count
       FROM attestation_queue
       WHERE status = 'failed' AND retry_count >= ?`
    )
    .bind(CONFIG.MAX_RETRIES)
    .all<QueueItem>();

  for (const item of abandoned.results || []) {
    console.error(
      `[ATTESTATION] Abandoned: ${item.entity_id}:${item.cid} (${item.retry_count} retries) - ${item.error_message}`
    );
  }
}

/**
 * Cleanup items stuck in 'uploading' or 'signing' state
 * Runs daily at 4 AM
 */
export async function cleanupStuckItems(env: Env): Promise<void> {
  console.log("[ATTESTATION] Cleaning up stuck items");

  const db = env.D1_PROD;
  const now = new Date().toISOString();

  // Reset items stuck in 'uploading' or 'signing' for too long
  const threshold = new Date(Date.now() - CONFIG.STUCK_THRESHOLD_MS).toISOString();

  const result = await db
    .prepare(
      `UPDATE attestation_queue
       SET status = 'pending', updated_at = ?
       WHERE status IN ('uploading', 'signing') AND updated_at < ?`
    )
    .bind(now, threshold)
    .run();

  if (result.meta.changes > 0) {
    console.log(`[ATTESTATION] Reset ${result.meta.changes} stuck items`);
  }
}

/**
 * Queue fetching operations
 */

import type { Env, QueueItem } from "../types";

/**
 * Fetch a single pending item from the queue (for sequential processing)
 */
export async function fetchNextPendingItem(env: Env): Promise<QueueItem | null> {
  const item = await env.D1_PROD
    .prepare(
      `SELECT * FROM attestation_queue
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .first<QueueItem>();

  return item || null;
}

/**
 * Fetch a batch of pending items from the queue (for parallel processing)
 */
export async function fetchPendingBatch(
  env: Env,
  limit: number
): Promise<QueueItem[]> {
  const result = await env.D1_PROD
    .prepare(
      `SELECT * FROM attestation_queue
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<QueueItem>();

  return result.results || [];
}

// D1 has a limit on SQL bound parameters, chunk operations to stay under it
const SQL_CHUNK_SIZE = 50;

/**
 * Mark multiple items as 'signing' (locked for batch processing)
 * Chunks the operation to stay under D1's SQL parameter limit
 */
export async function markBatchAsSigning(
  env: Env,
  itemIds: number[]
): Promise<void> {
  if (itemIds.length === 0) return;

  const now = new Date().toISOString();

  // Process in chunks to avoid D1's SQL variable limit
  for (let i = 0; i < itemIds.length; i += SQL_CHUNK_SIZE) {
    const chunk = itemIds.slice(i, i + SQL_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");

    await env.D1_PROD
      .prepare(
        `UPDATE attestation_queue
         SET status = 'signing', updated_at = ?
         WHERE id IN (${placeholders})`
      )
      .bind(now, ...chunk)
      .run();
  }
}

/**
 * Mark an item as uploading
 */
export async function markAsUploading(env: Env, itemId: number): Promise<void> {
  await env.D1_PROD
    .prepare(
      "UPDATE attestation_queue SET status = 'uploading', updated_at = ? WHERE id = ?"
    )
    .bind(new Date().toISOString(), itemId)
    .run();
}

/**
 * Mark an item as failed with error message
 */
export async function markAsFailed(
  env: Env,
  itemId: number,
  errorMessage: string
): Promise<void> {
  await env.D1_PROD
    .prepare(
      `UPDATE attestation_queue
       SET status = 'failed',
           retry_count = retry_count + 1,
           error_message = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(errorMessage, new Date().toISOString(), itemId)
    .run();
}

/**
 * Delete an item from the queue (on success)
 */
export async function deleteFromQueue(env: Env, itemId: number): Promise<void> {
  await env.D1_PROD
    .prepare("DELETE FROM attestation_queue WHERE id = ?")
    .bind(itemId)
    .run();
}

/**
 * Get the timestamp of the oldest pending item
 * Used to check if time threshold for bundling is met
 */
export async function getOldestPendingTimestamp(env: Env): Promise<number | null> {
  const result = await env.D1_PROD
    .prepare(
      `SELECT created_at FROM attestation_queue
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .first<{ created_at: string }>();

  if (!result) return null;

  return new Date(result.created_at).getTime();
}

/**
 * Queue statistics with detailed breakdown
 */
export interface QueueStats {
  pending: number;    // Waiting to be picked up
  processing: number; // Currently being signed/uploaded (was 'signing')
  failed: number;     // Failed, awaiting retry
  total: number;      // Total items in queue
}

/**
 * Get queue statistics grouped by status
 */
export async function getQueueStats(env: Env): Promise<QueueStats> {
  const stats: QueueStats = {
    pending: 0,
    processing: 0,
    failed: 0,
    total: 0,
  };

  try {
    const result = await env.D1_PROD.prepare(
      "SELECT status, COUNT(*) as count FROM attestation_queue GROUP BY status"
    ).all<{ status: string; count: number }>();

    for (const row of result.results || []) {
      if (row.status === "pending") {
        stats.pending = row.count;
      } else if (row.status === "signing" || row.status === "uploading") {
        // Both 'signing' (new) and 'uploading' (legacy) count as processing
        stats.processing += row.count;
      } else if (row.status === "failed") {
        stats.failed = row.count;
      }
      stats.total += row.count;
    }
  } catch {
    // Ignore errors for health check
  }

  return stats;
}

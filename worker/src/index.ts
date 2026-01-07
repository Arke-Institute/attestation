/**
 * Arke Attestation Worker
 *
 * Processes attestation queue and uploads manifests to Arweave as a sequential chain.
 * Each event links to the previous via prev_tx and prev_cid, creating a verifiable
 * global event log walkable purely on Arweave.
 *
 * Runs on cron schedule (every minute) to process pending items.
 * Only handles PROD network - test entities are not attested.
 */

import Arweave from "@irys/arweave";

// Types
interface Env {
  D1_PROD: D1Database;
  R2_MANIFESTS: R2Bucket;
  ATTESTATION_INDEX: KVNamespace;
  ARWEAVE_WALLET: string;
}

interface ChainHead {
  tx_id: string | null;
  cid: string | null;
  seq: number;
}

interface QueueItem {
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
}

interface Manifest {
  ver: number;
  [key: string]: unknown;
}

interface AttestationPayload {
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

interface ProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  duration: number;
}

// Constants
// Cron runs every 60s, use 55s of that window (5s buffer for cleanup)
const MAX_PROCESS_TIME_MS = 55000;
const MAX_RETRIES = 5;

// Arweave client
const arweave = new Arweave({ url: "https://arweave.net" });

export default {
  /**
   * HTTP handler - minimal endpoints for health/debugging
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check with queue stats
    if (url.pathname === "/") {
      const stats = await getQueueStats(env);
      const head = await getChainHead(env);

      return Response.json({
        status: "ok",
        service: "arke-attestation",
        version: "3.0.0",
        chain: {
          seq: head.seq,
          head_tx: head.tx_id,
        },
        queue: stats,
      });
    }

    // Manual trigger (for testing)
    if (url.pathname === "/trigger" && request.method === "POST") {
      const result = await processQueue(env);
      return Response.json(result);
    }

    return new Response("Not found", { status: 404 });
  },

  /**
   * Scheduled handler for cron triggers
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const trigger = event.cron;

    if (trigger === "* * * * *") {
      // Every minute: process attestation queue
      await processQueue(env);
    }

    if (trigger === "0 4 * * *") {
      // Daily 4 AM: retry failed items, cleanup stuck
      await retryFailedItems(env);
      await cleanupStuckItems(env);
    }
  },
};

// =============================================================================
// Chain State Management
// =============================================================================

async function getChainHead(env: Env): Promise<ChainHead> {
  const result = await env.D1_PROD.prepare(
    "SELECT tx_id, cid, seq FROM chain_state WHERE key = 'head'"
  ).first<ChainHead>();

  if (!result) {
    // Genesis state
    return { tx_id: null, cid: null, seq: 0 };
  }

  return result;
}

async function updateChainHead(
  env: Env,
  txId: string,
  cid: string,
  seq: number
): Promise<void> {
  await env.D1_PROD.prepare(
    "UPDATE chain_state SET tx_id = ?, cid = ?, seq = ?, updated_at = ? WHERE key = 'head'"
  )
    .bind(txId, cid, seq, new Date().toISOString())
    .run();
}

// =============================================================================
// Queue Processing (Sequential)
// =============================================================================

async function processQueue(env: Env): Promise<ProcessResult> {
  const startTime = Date.now();
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  // Process items sequentially until time limit
  while (Date.now() - startTime < MAX_PROCESS_TIME_MS) {
    const result = await processOneItem(env);

    if (result === null) {
      // No more items to process
      break;
    }

    processed++;
    if (result.success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  const duration = Date.now() - startTime;

  if (processed > 0) {
    console.log(
      `[ATTESTATION] Processed ${processed} items (${succeeded} succeeded, ${failed} failed) in ${duration}ms`
    );
  }

  return { processed, succeeded, failed, duration };
}

async function processOneItem(
  env: Env
): Promise<{ success: boolean } | null> {
  const db = env.D1_PROD;
  const r2 = env.R2_MANIFESTS;

  // 1. Get next pending item
  const item = await db
    .prepare(
      `SELECT * FROM attestation_queue
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .first<QueueItem>();

  if (!item) {
    return null; // No items to process
  }

  const now = new Date().toISOString();

  try {
    // 2. Mark as uploading
    await db
      .prepare(
        "UPDATE attestation_queue SET status = 'uploading', updated_at = ? WHERE id = ?"
      )
      .bind(now, item.id)
      .run();

    // 3. Get current chain head
    const head = await getChainHead(env);

    // 4. Fetch manifest from R2
    const r2Object = await r2.get(item.cid);
    if (!r2Object) {
      throw new Error(`Manifest not found in R2: ${item.cid}`);
    }

    const manifest = (await r2Object.json()) as Manifest;

    // 5. Validate manifest
    const ver = manifest.ver;
    if (typeof ver !== "number") {
      throw new Error(`Manifest missing ver field: ${item.cid}`);
    }

    // 6. Build payload with chain links
    const newSeq = head.seq + 1;
    const payload: AttestationPayload = {
      attestation: {
        pi: item.entity_id,
        ver,
        cid: item.cid,
        op: item.op,
        vis: item.vis,
        ts: new Date(item.ts).getTime(),
        prev_tx: head.tx_id,
        prev_cid: head.cid,
        seq: newSeq,
      },
      manifest,
    };

    // 7. Upload to Arweave
    if (!env.ARWEAVE_WALLET) {
      throw new Error("ARWEAVE_WALLET secret not configured");
    }

    const wallet = JSON.parse(env.ARWEAVE_WALLET);
    const data = JSON.stringify(payload);

    const tx = await arweave.createTransaction({ data }, wallet);

    // Add tags for queryability on Arweave
    tx.addTag("Content-Type", "application/json");
    tx.addTag("App-Name", "Arke");
    tx.addTag("Type", "attestation");
    tx.addTag("PI", item.entity_id);
    tx.addTag("Ver", ver.toString());
    tx.addTag("CID", item.cid);
    tx.addTag("Op", item.op);
    tx.addTag("Vis", item.vis);
    tx.addTag("Seq", newSeq.toString());

    if (head.tx_id) {
      tx.addTag("Prev-TX", head.tx_id);
    }

    await arweave.transactions.sign(tx, wallet);
    const response = await arweave.transactions.post(tx);

    if (response.status !== 200) {
      throw new Error(
        `Arweave upload failed: ${response.status} ${response.statusText}`
      );
    }

    const txId = tx.id;
    console.log(
      `[ATTESTATION] ✓ seq=${newSeq} ${item.entity_id}:v${ver} -> ${txId}`
    );

    // 8. Update chain head (CRITICAL - must succeed)
    await updateChainHead(env, txId, item.cid, newSeq);

    // 9. Store in KV index for fast lookups
    const kvData = JSON.stringify({
      cid: item.cid,
      tx: txId,
      seq: newSeq,
      ts: new Date(item.ts).getTime(),
    });

    // Store by entity:version
    await env.ATTESTATION_INDEX.put(`attest:${item.entity_id}:${ver}`, kvData);

    // Store/update latest pointer for entity
    await env.ATTESTATION_INDEX.put(`attest:${item.entity_id}:latest`, kvData);

    // 10. Delete from queue (success!)
    await db
      .prepare("DELETE FROM attestation_queue WHERE id = ?")
      .bind(item.id)
      .run();

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(
      `[ATTESTATION] ✗ ${item.entity_id}:${item.cid}: ${errorMessage}`
    );

    // Mark as failed
    await db
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

    return { success: false };
  }
}

// =============================================================================
// Retry & Cleanup
// =============================================================================

async function retryFailedItems(env: Env): Promise<void> {
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
    .bind(now, MAX_RETRIES)
    .run();

  console.log(`[ATTESTATION] Reset ${result.meta.changes} failed items`);

  // Log abandoned items (exceeded max retries)
  const abandoned = await db
    .prepare(
      `SELECT entity_id, cid, error_message, retry_count
       FROM attestation_queue
       WHERE status = 'failed' AND retry_count >= ?`
    )
    .bind(MAX_RETRIES)
    .all<QueueItem>();

  for (const item of abandoned.results || []) {
    console.error(
      `[ATTESTATION] Abandoned: ${item.entity_id}:${item.cid} (${item.retry_count} retries) - ${item.error_message}`
    );
  }
}

async function cleanupStuckItems(env: Env): Promise<void> {
  console.log("[ATTESTATION] Cleaning up stuck items");

  const db = env.D1_PROD;
  const now = new Date().toISOString();

  // Reset items stuck in 'uploading' for > 10 minutes
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `UPDATE attestation_queue
       SET status = 'pending', updated_at = ?
       WHERE status = 'uploading' AND updated_at < ?`
    )
    .bind(now, tenMinutesAgo)
    .run();

  if (result.meta.changes > 0) {
    console.log(`[ATTESTATION] Reset ${result.meta.changes} stuck items`);
  }
}

// =============================================================================
// Helpers
// =============================================================================

async function getQueueStats(
  env: Env
): Promise<Record<string, number>> {
  const stats: Record<string, number> = {
    pending: 0,
    uploading: 0,
    failed: 0,
  };

  try {
    const result = await env.D1_PROD.prepare(
      "SELECT status, COUNT(*) as count FROM attestation_queue GROUP BY status"
    ).all<{ status: string; count: number }>();

    for (const row of result.results || []) {
      stats[row.status] = row.count;
    }
  } catch {
    // Ignore errors for health check
  }

  return stats;
}

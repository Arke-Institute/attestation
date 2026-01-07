/**
 * Arke Attestation Worker
 *
 * Processes the attestation queue and uploads manifests to Arweave.
 * Runs on a cron schedule (every minute) to process pending items.
 *
 * Only handles PROD network - test entities are not attested.
 */

import Arweave from '@irys/arweave';

const arweave = new Arweave({ url: 'https://arweave.net' });

// Constants
const BATCH_SIZE = 50;
const MAX_RETRIES = 5;

export default {
  /**
   * HTTP handler for health checks and manual triggers
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/') {
      // Get queue stats
      let stats = { pending: 0, uploading: 0, failed: 0 };
      try {
        const result = await env.D1_PROD.prepare(`
          SELECT status, COUNT(*) as count FROM attestation_queue GROUP BY status
        `).all();
        for (const row of result.results || []) {
          stats[row.status] = row.count;
        }
      } catch (e) {
        // Ignore errors for health check
      }

      return Response.json({
        status: 'ok',
        service: 'arke-attestation',
        version: '2.0.0',
        queue: stats,
      });
    }

    // Manual trigger endpoint (for testing/debugging)
    if (url.pathname === '/trigger' && request.method === 'POST') {
      ctx.waitUntil(processQueue(env));
      return Response.json({ message: 'Queue processing triggered' });
    }

    // Manual retry endpoint
    if (url.pathname === '/retry' && request.method === 'POST') {
      ctx.waitUntil(retryFailedItems(env));
      return Response.json({ message: 'Retry job triggered' });
    }

    return new Response('Not found', { status: 404 });
  },

  /**
   * Scheduled handler for cron triggers
   */
  async scheduled(event, env, ctx) {
    const trigger = event.cron;

    if (trigger === '* * * * *') {
      // Every minute: process attestation queue
      await processQueue(env);
    }

    if (trigger === '0 4 * * *') {
      // Daily 4 AM: retry failed items, cleanup stuck
      await retryFailedItems(env);
      await cleanupStuckItems(env);
    }
  },
};

// =============================================================================
// Queue Processing
// =============================================================================

/**
 * Process pending items from the attestation queue.
 * Fetches manifests from R2, uploads to Arweave, stores TX in KV.
 */
async function processQueue(env) {
  const db = env.D1_PROD;
  const r2 = env.R2_MANIFESTS;

  // Fetch pending items
  const pending = await db.prepare(`
    SELECT * FROM attestation_queue
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(BATCH_SIZE).all();

  if (!pending.results || pending.results.length === 0) {
    return;
  }

  console.log(`[ATTESTATION] Processing ${pending.results.length} items`);

  for (const record of pending.results) {
    try {
      await processQueueItem(record, db, r2, env);
    } catch (error) {
      console.error(`[ATTESTATION] Failed ${record.entity_id}:${record.cid}:`, error.message || error);

      await db.prepare(`
        UPDATE attestation_queue
        SET status = 'failed',
            retry_count = retry_count + 1,
            error_message = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(String(error.message || error), new Date().toISOString(), record.id).run();
    }
  }
}

/**
 * Process a single queue item:
 * 1. Mark as uploading
 * 2. Fetch manifest from R2
 * 3. Upload to Arweave with tags
 * 4. Store TX ID in KV
 * 5. Delete from queue
 */
async function processQueueItem(record, db, r2, env) {
  const now = new Date().toISOString();

  // 1. Mark as uploading
  await db.prepare(`
    UPDATE attestation_queue SET status = 'uploading', updated_at = ? WHERE id = ?
  `).bind(now, record.id).run();

  // 2. Fetch manifest from R2 (key is just the CID)
  const r2Object = await r2.get(record.cid);

  if (!r2Object) {
    throw new Error(`Manifest not found in R2: ${record.cid}`);
  }

  const manifest = await r2Object.json();

  // 3. Extract version number (authoritative source from manifest)
  const ver = manifest.ver;
  if (typeof ver !== 'number') {
    throw new Error(`Manifest missing ver field: ${record.cid}`);
  }

  // 4. Prepare upload payload
  const payload = {
    attestation: {
      pi: record.entity_id,
      ver,
      cid: record.cid,
      op: record.op,
      vis: record.vis,
      prev_cid: record.prev_cid,
      ts: new Date(record.ts).getTime(),
    },
    manifest,
  };

  // 5. Upload to Arweave
  if (!env.ARWEAVE_WALLET) {
    throw new Error('ARWEAVE_WALLET secret not configured');
  }

  const wallet = JSON.parse(env.ARWEAVE_WALLET);
  const data = JSON.stringify(payload);

  const tx = await arweave.createTransaction({ data }, wallet);

  // Add tags for queryability on Arweave
  tx.addTag('Content-Type', 'application/json');
  tx.addTag('App-Name', 'Arke');
  tx.addTag('Type', 'manifest');
  tx.addTag('PI', record.entity_id);
  tx.addTag('Ver', ver.toString());
  tx.addTag('CID', record.cid);
  tx.addTag('Op', record.op);
  tx.addTag('Vis', record.vis);

  if (record.prev_cid) {
    tx.addTag('Prev-CID', record.prev_cid);
  }

  await arweave.transactions.sign(tx, wallet);
  const response = await arweave.transactions.post(tx);

  if (response.status !== 200) {
    throw new Error(`Arweave upload failed: ${response.status} ${response.statusText}`);
  }

  console.log(`[ATTESTATION] Uploaded ${record.entity_id}:v${ver} -> ${tx.id}`);

  // 6. Store TX ID in KV index (keyed by pi:ver)
  const kvKey = `attest:${record.entity_id}:${ver}`;
  await env.ATTESTATION_INDEX.put(kvKey, JSON.stringify({
    cid: record.cid,
    tx: tx.id,
    ts: new Date(record.ts).getTime(),
  }));

  // 7. Delete from queue (success!)
  await db.prepare('DELETE FROM attestation_queue WHERE id = ?').bind(record.id).run();
}

// =============================================================================
// Retry Logic
// =============================================================================

/**
 * Reset failed items (with retries remaining) back to pending.
 * Log items that have exceeded max retries.
 */
async function retryFailedItems(env) {
  console.log('[ATTESTATION] Running retry job');

  const db = env.D1_PROD;

  // Reset failed items with retries remaining
  const result = await db.prepare(`
    UPDATE attestation_queue
    SET status = 'pending', updated_at = ?
    WHERE status = 'failed' AND retry_count < ?
  `).bind(new Date().toISOString(), MAX_RETRIES).run();

  console.log(`[ATTESTATION] Reset ${result.meta.changes} failed items`);

  // Log abandoned items
  const abandoned = await db.prepare(`
    SELECT entity_id, cid, error_message, retry_count FROM attestation_queue
    WHERE status = 'failed' AND retry_count >= ?
  `).bind(MAX_RETRIES).all();

  for (const item of abandoned.results || []) {
    console.error(`[ATTESTATION] Abandoned: ${item.entity_id}:${item.cid} (${item.retry_count} retries) - ${item.error_message}`);
  }
}

/**
 * Reset items stuck in 'uploading' state for too long.
 * This handles cases where the worker crashed mid-upload.
 */
async function cleanupStuckItems(env) {
  console.log('[ATTESTATION] Cleaning up stuck items');

  const db = env.D1_PROD;

  // Reset items stuck in 'uploading' for > 10 minutes
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const result = await db.prepare(`
    UPDATE attestation_queue
    SET status = 'pending', updated_at = ?
    WHERE status = 'uploading' AND updated_at < ?
  `).bind(new Date().toISOString(), tenMinutesAgo).run();

  if (result.meta.changes > 0) {
    console.log(`[ATTESTATION] Reset ${result.meta.changes} stuck items`);
  }
}

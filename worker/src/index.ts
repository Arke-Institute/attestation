/**
 * Arke Attestation Worker
 *
 * Processes attestation queue and uploads manifests to Arweave as a sequential chain.
 * Each event links to the previous via prev_tx and prev_cid, creating a verifiable
 * global event log walkable purely on Arweave.
 *
 * Uses parallel pre-signing for high throughput:
 * - Sign all transactions locally (fast, ~1-5ms each)
 * - Upload all transactions in parallel (slow part parallelized)
 *
 * Runs on cron schedule (every minute) to process pending items.
 * Only handles PROD network - test entities are not attested.
 */

import type { Env, ProcessResult } from "./types";
import { CONFIG } from "./config";
import { getChainHead } from "./chain/state";
import { getQueueStats } from "./queue/fetch";
import { retryFailedItems, cleanupStuckItems } from "./queue/cleanup";
import { processQueue } from "./process";
import { runBundleTest } from "./test/bundleTest";

// Track last batch result for health endpoint
let lastBatch: (ProcessResult & { timestamp: string }) | null = null;

/**
 * Check if request has valid admin authorization
 * Expects: Authorization: Bearer <ADMIN_SECRET>
 */
function isAuthorized(request: Request, env: Env): boolean {
  // If no secret configured, allow all (for backwards compatibility)
  if (!env.ADMIN_SECRET) return true;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;

  const [scheme, token] = authHeader.split(" ");
  return scheme === "Bearer" && token === env.ADMIN_SECRET;
}

export default {
  /**
   * HTTP handler - minimal endpoints for health/debugging
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check with queue stats (public)
    if (url.pathname === "/") {
      const stats = await getQueueStats(env);
      const head = await getChainHead(env);

      return Response.json({
        status: "ok",
        service: "arke-attestation",
        version: "4.0.0",
        config: {
          batch_size: CONFIG.BATCH_SIZE,
        },
        chain: {
          seq: head.seq,
          head_tx: head.tx_id,
        },
        queue: stats,
        last_batch: lastBatch,
      });
    }

    // Manual trigger (admin only)
    if (url.pathname === "/trigger" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const result = await processQueue(env);
      lastBatch = { ...result, timestamp: new Date().toISOString() };
      return Response.json(result);
    }

    // Bundle test endpoint - uploads to real Arweave but uses isolated test chain
    // Usage: POST /test-bundle?count=10 (admin only)
    if (url.pathname === "/test-bundle" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const count = parseInt(url.searchParams.get("count") || "5", 10);
      if (count < 1 || count > 100) {
        return Response.json({ error: "count must be between 1 and 100" }, { status: 400 });
      }

      const result = await runBundleTest(env, count);
      return Response.json(result);
    }

    return new Response("Not found", { status: 404 });
  },

  /**
   * Scheduled handler for cron triggers
   */
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const trigger = event.cron;

    if (trigger === "* * * * *") {
      // Every minute: cleanup stuck items first, then process queue
      // This ensures stuck items are reset before being picked up again
      await cleanupStuckItems(env);
      await processQueue(env);
    }

    if (trigger === "0 4 * * *") {
      // Daily 4 AM: retry failed items, cleanup stuck
      await retryFailedItems(env);
      await cleanupStuckItems(env);
    }
  },
};

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
import {
  verifyPendingBundles,
  getVerificationStats,
  getPendingBundles,
  addTestBundle,
  checkBundleSeededPublic,
} from "./verify/bundleTracker";
import { checkWalletBalance } from "./balance/check";

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
      const verification = await getVerificationStats(env);

      // Check wallet balance (handle errors gracefully)
      let wallet: { address: string; balance_ar: string; status: string } | null = null;
      try {
        const balance = await checkWalletBalance(env);
        wallet = {
          address: balance.address,
          balance_ar: balance.balanceAR,
          status: balance.isCritical ? "critical" : balance.isLow ? "low" : "ok",
        };
      } catch (error) {
        console.error(`[HEALTH] Balance check failed: ${error}`);
      }

      return Response.json({
        status: "ok",
        service: "arke-attestation",
        version: "4.2.0",
        config: {
          batch_size: CONFIG.BATCH_SIZE,
          balance_warning_threshold_ar: CONFIG.BALANCE_WARNING_THRESHOLD_AR,
          balance_critical_threshold_ar: CONFIG.BALANCE_CRITICAL_THRESHOLD_AR,
        },
        chain: {
          seq: head.seq,
          head_tx: head.tx_id,
        },
        queue: stats,
        wallet,
        verification,
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

    // Verification test endpoint (admin only)
    // GET /test-verify - Show pending bundles and run verification
    // POST /test-verify?bundleTxId=xxx&ageMinutes=15 - Add test bundle record
    // GET /test-verify/check?bundleTxId=xxx - Check if specific bundle is seeded
    if (url.pathname === "/test-verify") {
      if (!isAuthorized(request, env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      if (request.method === "GET") {
        // Show current bundles and run verification
        const bundlesBefore = await getPendingBundles(env);
        const result = await verifyPendingBundles(env);
        const bundlesAfter = await getPendingBundles(env);

        return Response.json({
          verification_result: result,
          bundles_before: bundlesBefore,
          bundles_after: bundlesAfter,
          config: {
            grace_period_minutes: CONFIG.BUNDLE_SEED_GRACE_PERIOD_MS / 60000,
            timeout_minutes: CONFIG.BUNDLE_SEED_TIMEOUT_MS / 60000,
          },
        });
      }

      if (request.method === "POST") {
        // Add a test bundle record
        const bundleTxId = url.searchParams.get("bundleTxId");
        if (!bundleTxId) {
          return Response.json({ error: "bundleTxId is required" }, { status: 400 });
        }

        const ageMinutes = parseInt(url.searchParams.get("ageMinutes") || "0", 10);
        const itemCount = parseInt(url.searchParams.get("itemCount") || "1", 10);

        const bundle = await addTestBundle(env, bundleTxId, { ageMinutes, itemCount });
        const isSeeded = await checkBundleSeededPublic(bundleTxId);

        return Response.json({
          message: "Test bundle added",
          bundle,
          current_seeding_status: isSeeded,
          will_be_checked_after_minutes: CONFIG.BUNDLE_SEED_GRACE_PERIOD_MS / 60000 - ageMinutes,
        });
      }
    }

    if (url.pathname === "/test-verify/check" && request.method === "GET") {
      if (!isAuthorized(request, env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const bundleTxId = url.searchParams.get("bundleTxId");
      if (!bundleTxId) {
        return Response.json({ error: "bundleTxId is required" }, { status: 400 });
      }

      const isSeeded = await checkBundleSeededPublic(bundleTxId);
      return Response.json({
        bundleTxId,
        isSeeded,
        checkedAt: new Date().toISOString(),
      });
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
      // Every minute: cleanup stuck items first, then process queue, then verify bundles
      // This ensures stuck items are reset before being picked up again
      await cleanupStuckItems(env);
      await processQueue(env);
      await verifyPendingBundles(env);
    }

    if (trigger === "0 4 * * *") {
      // Daily 4 AM: retry failed items, cleanup stuck
      await retryFailedItems(env);
      await cleanupStuckItems(env);
    }
  },
};

/**
 * Alert system for bundle verification failures
 *
 * Sends Discord notifications when bundles fail to seed.
 */

import { createAlerter, type Alerter } from "@arke-institute/alerting";
import type { Env, PendingBundle } from "../types";
import { CONFIG } from "../config";

// Cache alerter instance per request context
let cachedAlerter: Alerter | null = null;

/**
 * Get or create alerter instance
 */
function getAlerter(env: Env): Alerter {
  if (!cachedAlerter) {
    cachedAlerter = createAlerter({
      webhookUrl: env.DISCORD_ALERT_WEBHOOK,
      defaultRepo: "attestation",
    });
  }
  return cachedAlerter;
}

/**
 * Send an alert when a bundle fails to seed
 */
export async function sendSeedingFailureAlert(
  env: Env,
  bundle: PendingBundle,
  requeuedCount: number
): Promise<void> {
  const alerter = getAlerter(env);
  const timeoutMinutes = Math.round(CONFIG.BUNDLE_SEED_TIMEOUT_MS / 60000);

  await alerter.error("Bundle Seeding Failed", `Bundle failed to seed after ${timeoutMinutes} minutes`, {
    bundle_tx: bundle.bundleTxId,
    items_affected: String(bundle.itemCount),
    entities_requeued: String(requeuedCount),
    uploaded_at: new Date(bundle.uploadedAt).toISOString(),
  });
}

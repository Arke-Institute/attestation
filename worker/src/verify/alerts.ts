/**
 * Alert system for bundle verification failures
 *
 * Sends webhook notifications when bundles fail to seed.
 */

import type { Env, PendingBundle } from "../types";
import { CONFIG } from "../config";

/**
 * Send an alert when a bundle fails to seed
 */
export async function sendSeedingFailureAlert(
  env: Env,
  bundle: PendingBundle,
  requeuedCount: number
): Promise<void> {
  const timeoutMinutes = Math.round(CONFIG.BUNDLE_SEED_TIMEOUT_MS / 60000);

  const message = {
    text: `Arke Attestation: Bundle Seeding Failure`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Bundle failed to seed after ${timeoutMinutes} minutes*\n` +
            `- Bundle TX: \`${bundle.bundleTxId}\`\n` +
            `- Items affected: ${bundle.itemCount}\n` +
            `- Entities re-queued: ${requeuedCount}\n` +
            `- Uploaded: ${new Date(bundle.uploadedAt).toISOString()}`,
        },
      },
    ],
  };

  if (env.ALERT_WEBHOOK_URL) {
    try {
      await fetch(env.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
      console.log(`[ALERT] Sent seeding failure alert for bundle ${bundle.bundleTxId}`);
    } catch (error) {
      console.error(`[ALERT] Failed to send webhook: ${error}`);
    }
  } else {
    console.warn(`[ALERT] No webhook configured. Alert: ${JSON.stringify(message)}`);
  }
}

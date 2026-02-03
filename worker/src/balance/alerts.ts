/**
 * Balance-specific alerts
 *
 * Sends Discord alerts when wallet balance is low or critical.
 */

import { createAlerter, type Alerter } from "@arke-institute/alerting";
import type { Env, BalanceInfo } from "../types";
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
 * Send alert for low wallet balance
 */
export async function sendLowBalanceAlert(
  env: Env,
  balance: BalanceInfo
): Promise<void> {
  const alerter = getAlerter(env);

  const fields = {
    address: balance.address,
    balance: `${balance.balanceAR} AR`,
    warning_threshold: `${CONFIG.BALANCE_WARNING_THRESHOLD_AR} AR`,
    critical_threshold: `${CONFIG.BALANCE_CRITICAL_THRESHOLD_AR} AR`,
  };

  if (balance.isCritical) {
    await alerter.critical(
      "Wallet Balance Critical",
      `Balance is below ${CONFIG.BALANCE_CRITICAL_THRESHOLD_AR} AR. Attestation processing has been halted.`,
      fields
    );
  } else if (balance.isLow) {
    await alerter.warn(
      "Wallet Balance Low",
      `Balance is below ${CONFIG.BALANCE_WARNING_THRESHOLD_AR} AR. Please top up the wallet soon.`,
      fields
    );
  }
}

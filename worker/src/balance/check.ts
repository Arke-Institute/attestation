/**
 * Wallet balance checking
 *
 * Checks AR wallet balance and determines if it's low or critical.
 * Used to prevent wasted processing when wallet can't afford uploads.
 */

import { arweave } from "../arweave";
import type { Env, BalanceInfo } from "../types";
import { CONFIG } from "../config";

/**
 * Convert winston (smallest unit) to AR
 * 1 AR = 10^12 winston
 */
function winstonToAr(winston: string): string {
  const winstonNum = BigInt(winston);
  const divisor = BigInt(1_000_000_000_000); // 10^12
  const ar = Number(winstonNum) / Number(divisor);
  return ar.toFixed(12).replace(/\.?0+$/, ""); // Remove trailing zeros
}

/**
 * Check wallet balance and return status
 */
export async function checkWalletBalance(env: Env): Promise<BalanceInfo> {
  const wallet = JSON.parse(env.ARWEAVE_WALLET);
  const address = await arweave.wallets.jwkToAddress(wallet);
  const balanceWinston = await arweave.wallets.getBalance(address);
  const balanceAR = winstonToAr(balanceWinston);

  const balanceNum = parseFloat(balanceAR);

  return {
    address,
    balanceAR,
    balanceWinston,
    isLow: balanceNum < CONFIG.BALANCE_WARNING_THRESHOLD_AR,
    isCritical: balanceNum < CONFIG.BALANCE_CRITICAL_THRESHOLD_AR,
  };
}

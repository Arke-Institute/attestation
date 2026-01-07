/**
 * Parallel upload of signed transactions to Arweave
 */

import type { PendingTransaction, UploadResult } from "../types";
import { arweave } from "../arweave";

/**
 * Upload multiple signed transactions to Arweave in parallel
 *
 * @param pending - Array of signed pending transactions
 * @returns Map of TX ID -> upload result
 */
export async function uploadParallel(
  pending: PendingTransaction[]
): Promise<Map<string, UploadResult>> {
  const results = new Map<string, UploadResult>();

  // Upload all in parallel
  const uploads = pending.map(async (p) => {
    try {
      // The signedTx is the actual Arweave transaction object
      const response = await arweave.transactions.post(p.signedTx);

      if (response.status !== 200) {
        throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
      }

      results.set(p.txId, {
        txId: p.txId,
        success: true,
      });
    } catch (error) {
      results.set(p.txId, {
        txId: p.txId,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  });

  await Promise.all(uploads);
  return results;
}

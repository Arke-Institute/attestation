/**
 * Bundle upload to Arweave
 *
 * Takes multiple signed DataItems, bundles them into a single L1 transaction,
 * and uploads to Arweave. Each DataItem maintains its own TX ID.
 *
 * Includes verification to prevent "ghost uploads" where the transaction is
 * accepted but data never seeds to gateways.
 */

import { bundleAndSignData, ArweaveSigner, DataItem } from "../bundle";
import type { JWKInterface } from "../bundle";
import { arweave } from "../arweave";

// Verification settings
const VERIFY_RETRIES = 3;
const VERIFY_DELAY_MS = 2000; // 2 seconds between retries

/**
 * Upload a bundle of DataItems to Arweave
 *
 * @param dataItems - Array of signed DataItems to bundle
 * @param wallet - JWK wallet for signing the L1 transaction
 * @returns The L1 bundle transaction ID (note: individual DataItem IDs are used for lookups)
 */
export async function uploadBundle(
  dataItems: DataItem[],
  wallet: JWKInterface
): Promise<{ bundleTxId: string; dataItemIds: string[] }> {
  if (dataItems.length === 0) {
    throw new Error("Cannot upload empty bundle");
  }

  const signer = new ArweaveSigner(wallet);

  // Bundle all DataItems together
  const bundle = await bundleAndSignData(dataItems, signer);

  // Create L1 transaction containing the bundle
  // The bundle.toTransaction method adds Bundle-Format and Bundle-Version tags
  const tx = await bundle.toTransaction(
    {},
    arweave as unknown as { createTransaction: (opts: unknown, jwk: unknown) => Promise<unknown> },
    wallet
  );

  // Sign the L1 transaction
  await arweave.transactions.sign(tx as Parameters<typeof arweave.transactions.sign>[0], wallet);

  // Upload to Arweave
  const response = await arweave.transactions.post(tx as Parameters<typeof arweave.transactions.post>[0]);

  if (response.status !== 200) {
    throw new Error(`Bundle upload failed: ${response.status} ${response.statusText}`);
  }

  // Verify the transaction is queryable (confirms it reached the network)
  // This prevents "ghost uploads" where HTTP 200 is returned but data never propagates
  const verified = await verifyTransactionExists(tx.id);
  if (!verified) {
    throw new Error(`Bundle upload verification failed: ${tx.id} not queryable after upload`);
  }

  // Return both the L1 TX ID and all DataItem IDs
  return {
    bundleTxId: tx.id,
    dataItemIds: dataItems.map((item) => item.id),
  };
}

/**
 * Verify a transaction exists on the network by querying for it
 * Retries a few times to allow for propagation delay
 */
async function verifyTransactionExists(txId: string): Promise<boolean> {
  for (let attempt = 0; attempt < VERIFY_RETRIES; attempt++) {
    try {
      // Query for the transaction status
      const statusResponse = await fetch(`https://arweave.net/tx/${txId}/status`);

      if (statusResponse.ok) {
        const status = await statusResponse.json() as { block_height?: number };
        // If we get a block_height, transaction is confirmed
        if (status.block_height) {
          return true;
        }
      }

      // Also check if transaction exists (even if not confirmed yet)
      const txResponse = await fetch(`https://arweave.net/tx/${txId}`);
      if (txResponse.ok) {
        return true;
      }
    } catch {
      // Network error, will retry
    }

    // Wait before retrying (skip on last attempt)
    if (attempt < VERIFY_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS));
    }
  }

  return false;
}

/**
 * Calculate total size of DataItems in bytes
 */
export function calculateBundleSize(dataItems: DataItem[]): number {
  return dataItems.reduce((total, item) => total + item.getRaw().byteLength, 0);
}

/**
 * Bundle upload to Arweave
 *
 * Takes multiple signed DataItems, bundles them into a single L1 transaction,
 * and uploads to Arweave. Each DataItem maintains its own TX ID.
 */

import { bundleAndSignData, ArweaveSigner, DataItem } from "../bundle";
import type { JWKInterface } from "../bundle";
import { arweave } from "../arweave";

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

  // Return both the L1 TX ID and all DataItem IDs
  return {
    bundleTxId: tx.id,
    dataItemIds: dataItems.map((item) => item.id),
  };
}

/**
 * Calculate total size of DataItems in bytes
 */
export function calculateBundleSize(dataItems: DataItem[]): number {
  return dataItems.reduce((total, item) => total + item.getRaw().byteLength, 0);
}

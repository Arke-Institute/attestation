/**
 * Bundle testing module
 *
 * Provides isolated testing of the bundling flow without affecting production.
 * Uses a separate test chain head and generates synthetic test data.
 */

import type { Env, QueueItem, Manifest, PendingDataItem } from "../types";
import { getChainHead, resetChainHead, CHAIN_KEY_TEST } from "../chain/state";
import { signDataItemBatch, extractDataItems } from "../chain/signDataItems";
import { uploadBundle, calculateBundleSize } from "../upload/bundle";
import { finalizeBundleSuccess } from "../queue/finalizeBundle";

export interface TestResult {
  success: boolean;
  testChainKey: string;
  itemCount: number;
  bundleSize: number;
  bundleTxId?: string;
  dataItemIds: string[];
  arweaveUrls: string[];
  chainHead: {
    before: { seq: number; tx_id: string | null };
    after: { seq: number; tx_id: string | null };
  };
  timing: {
    signMs: number;
    uploadMs: number;
    totalMs: number;
  };
  error?: string;
}

/**
 * Generate a deterministic fake CID for testing
 */
function generateTestCid(index: number): string {
  // Use a simple pattern that looks like a CID
  return `bafkreitest${String(index).padStart(8, "0")}${Date.now().toString(36)}`;
}

/**
 * Generate test manifest
 */
function generateTestManifest(index: number): Manifest {
  return {
    ver: 1,
    name: `Test Entity ${index}`,
    description: `Test manifest for bundle testing - item ${index}`,
    created: new Date().toISOString(),
    test: true,
  };
}

/**
 * Generate synthetic queue items for testing
 * These don't go into the actual queue - they're created in memory
 */
function generateTestItems(count: number): { items: QueueItem[]; manifests: Map<string, Manifest> } {
  const items: QueueItem[] = [];
  const manifests = new Map<string, Manifest>();
  const now = new Date().toISOString();

  for (let i = 0; i < count; i++) {
    const cid = generateTestCid(i);
    const entityId = `pi_test_bundle_${i}`;

    items.push({
      id: 1000000 + i, // High ID to avoid conflicts
      entity_id: entityId,
      cid,
      op: "create",
      vis: "public",
      ts: now,
      created_at: now,
      status: "pending",
      retry_count: 0,
      error_message: null,
    });

    manifests.set(cid, generateTestManifest(i));
  }

  return { items, manifests };
}

/**
 * Run a bundle test with synthetic data
 *
 * @param env - Worker environment
 * @param count - Number of items to bundle (default: 5)
 * @returns Test result with DataItem IDs for verification
 */
export async function runBundleTest(env: Env, count: number = 5): Promise<TestResult> {
  const startTime = Date.now();

  // Reset test chain to genesis
  await resetChainHead(env, CHAIN_KEY_TEST);
  const headBefore = await getChainHead(env, CHAIN_KEY_TEST);

  // Generate test data
  const { items, manifests } = generateTestItems(count);

  // Sign all items as DataItems
  const signStart = Date.now();
  let pending: PendingDataItem[];

  try {
    pending = await signDataItemBatch(env, items, manifests, headBefore);
  } catch (error) {
    return {
      success: false,
      testChainKey: CHAIN_KEY_TEST,
      itemCount: count,
      bundleSize: 0,
      dataItemIds: [],
      arweaveUrls: [],
      chainHead: {
        before: { seq: headBefore.seq, tx_id: headBefore.tx_id },
        after: { seq: headBefore.seq, tx_id: headBefore.tx_id },
      },
      timing: { signMs: Date.now() - signStart, uploadMs: 0, totalMs: Date.now() - startTime },
      error: `Signing failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const signMs = Date.now() - signStart;

  // Calculate bundle size
  const dataItems = extractDataItems(pending);
  const bundleSize = calculateBundleSize(dataItems);

  // Upload bundle
  const uploadStart = Date.now();
  let bundleTxId: string;

  try {
    const wallet = JSON.parse(env.ARWEAVE_WALLET);
    const result = await uploadBundle(dataItems, wallet);
    bundleTxId = result.bundleTxId;
  } catch (error) {
    return {
      success: false,
      testChainKey: CHAIN_KEY_TEST,
      itemCount: count,
      bundleSize,
      dataItemIds: pending.map((p) => p.txId),
      arweaveUrls: [],
      chainHead: {
        before: { seq: headBefore.seq, tx_id: headBefore.tx_id },
        after: { seq: headBefore.seq, tx_id: headBefore.tx_id },
      },
      timing: { signMs, uploadMs: Date.now() - uploadStart, totalMs: Date.now() - startTime },
      error: `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const uploadMs = Date.now() - uploadStart;

  // Finalize (update test chain head, skip queue deletion since items aren't in queue)
  await finalizeBundleSuccess(env, pending, headBefore, {
    chainKey: CHAIN_KEY_TEST,
    skipQueue: true,
  });

  const headAfter = await getChainHead(env, CHAIN_KEY_TEST);
  const totalMs = Date.now() - startTime;

  // Build result
  const dataItemIds = pending.map((p) => p.txId);

  return {
    success: true,
    testChainKey: CHAIN_KEY_TEST,
    itemCount: count,
    bundleSize,
    bundleTxId,
    dataItemIds,
    arweaveUrls: dataItemIds.map((id) => `https://arweave.net/${id}`),
    chainHead: {
      before: { seq: headBefore.seq, tx_id: headBefore.tx_id },
      after: { seq: headAfter.seq, tx_id: headAfter.tx_id },
    },
    timing: { signMs, uploadMs, totalMs },
  };
}

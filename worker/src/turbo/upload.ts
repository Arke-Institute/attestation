/**
 * Turbo upload with retry logic
 *
 * Uploads attestations via Turbo HTTP API with:
 * - Sequential signing to maintain chain integrity (prev_tx links)
 * - Parallel uploads for speed (IDs known after signing)
 * - Retry logic with exponential backoff
 * - 402 error handling for paid uploads
 * - Per-item success/failure tracking
 *
 * Uses the existing bundle module for DataItem creation/signing,
 * then POSTs to Turbo's HTTP API (bypasses SDK crypto issues).
 */

import { createData, ArweaveSigner, type DataItem } from "../bundle";
import type { Env, AttestationPayload, QueueItem, Manifest, ChainHead } from "../types";
import { CONFIG } from "../config";

const TURBO_UPLOAD_URL = "https://upload.ardrive.io/v1/tx";

export interface TurboUploadItem {
  queueItem: QueueItem;
  manifest: Manifest;
  payload: AttestationPayload;
  seq: number;
  signedDataItem?: DataItem;
  txId?: string; // Known after signing, before upload
}

export interface TurboUploadResult {
  item: TurboUploadItem;
  success: boolean;
  txId?: string;
  error?: string;
  attempts: number;
}

export interface TurboBatchResult {
  results: TurboUploadResult[];
  succeeded: TurboUploadResult[];
  failed: TurboUploadResult[];
  totalTimeMs: number;
}

interface TurboUploadResponse {
  id: string;
  owner: string;
  dataCaches: string[];
  fastFinalityIndexes: string[];
  winc?: string;
}

/**
 * Build Arweave tags for an attestation
 */
function buildTags(payload: AttestationPayload): Array<{ name: string; value: string }> {
  const att = payload.attestation;

  const tags = [
    { name: "Content-Type", value: "application/json" },
    { name: "App-Name", value: "Arke" },
    { name: "Type", value: "attestation" },
    { name: "PI", value: att.pi },
    { name: "Ver", value: String(att.ver) },
    { name: "CID", value: att.cid },
    { name: "Op", value: att.op },
    { name: "Vis", value: att.vis },
    { name: "Seq", value: String(att.seq) },
  ];

  if (att.prev_tx) {
    tags.push({ name: "Prev-TX", value: att.prev_tx });
  }

  if (att.prev_cid) {
    tags.push({ name: "Prev-CID", value: att.prev_cid });
  }

  return tags;
}

/**
 * Check if an error is a 402 (payment required)
 */
function is402Error(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("status" in error && error.status === 402) return true;
  const msg = String(error);
  return msg.includes("402") || msg.toLowerCase().includes("insufficient balance");
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prepare and sign all items sequentially to maintain chain integrity.
 *
 * Each item's prev_tx references the previous item's txId (dataItem.id).
 * The txId is known immediately after signing, before any upload.
 *
 * @param env - Worker environment
 * @param items - Queue items to process
 * @param manifests - Map of CID -> Manifest
 * @param head - Current chain head
 * @returns Array of items with signed DataItems and known txIds
 */
export async function signItemsSequentially(
  env: Env,
  items: QueueItem[],
  manifests: Map<string, Manifest>,
  head: ChainHead
): Promise<TurboUploadItem[]> {
  const wallet = JSON.parse(env.ARWEAVE_WALLET);
  const signer = new ArweaveSigner(wallet);

  const signedItems: TurboUploadItem[] = [];

  // Chain state - starts from current head
  let prevTx: string | null = head.tx_id;
  let prevCid = head.cid;
  let seq = head.seq;

  for (const item of items) {
    const manifest = manifests.get(item.cid);
    if (!manifest) {
      console.warn(`[TURBO] Skipping ${item.cid} - manifest not found`);
      continue;
    }

    seq++;

    // Build payload with chain links
    const payload: AttestationPayload = {
      attestation: {
        pi: item.entity_id,
        ver: manifest.ver,
        cid: item.cid,
        op: item.op,
        vis: item.vis,
        ts: new Date(item.ts).getTime(),
        prev_tx: prevTx,
        prev_cid: prevCid,
        seq,
      },
      manifest,
    };

    // Build tags and create DataItem
    const tags = buildTags(payload);
    const dataItem = createData(JSON.stringify(payload), signer, { tags });

    // Sign DataItem - ID is now known!
    await dataItem.sign(signer);
    const txId = dataItem.id;

    signedItems.push({
      queueItem: item,
      manifest,
      payload,
      seq,
      signedDataItem: dataItem,
      txId,
    });

    // Update chain pointers for next iteration
    prevTx = txId;
    prevCid = item.cid;
  }

  return signedItems;
}

/**
 * Upload a signed DataItem to Turbo
 */
async function uploadToTurbo(dataItem: DataItem): Promise<TurboUploadResponse> {
  const rawData = dataItem.getRaw();

  const response = await fetch(TURBO_UPLOAD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: rawData,
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Turbo upload failed (${response.status}): ${text}`);
    (error as any).status = response.status;
    throw error;
  }

  return response.json() as Promise<TurboUploadResponse>;
}

/**
 * Upload a single pre-signed item to Turbo with retries
 */
async function uploadSignedItem(item: TurboUploadItem): Promise<TurboUploadResult> {
  if (!item.signedDataItem) {
    return {
      item,
      success: false,
      error: "Item not signed",
      attempts: 0,
    };
  }

  let lastError: string | undefined;
  let attempts = 0;

  for (let attempt = 0; attempt < CONFIG.TURBO_MAX_RETRIES; attempt++) {
    attempts = attempt + 1;

    try {
      const result = await uploadToTurbo(item.signedDataItem);

      // Verify the returned ID matches what we expect
      if (result.id !== item.txId) {
        console.warn(
          `[TURBO] ID mismatch for ${item.queueItem.entity_id}: expected ${item.txId}, got ${result.id}`
        );
      }

      return {
        item,
        success: true,
        txId: item.txId, // Use the pre-computed txId
        attempts,
      };
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);

      // Don't retry 402 errors (payment required)
      if (is402Error(error)) {
        console.log(
          `[TURBO] 402 for ${item.queueItem.entity_id} - insufficient credits`
        );
        break;
      }

      // Exponential backoff for other errors
      if (attempt < CONFIG.TURBO_MAX_RETRIES - 1) {
        const backoffMs = CONFIG.TURBO_RETRY_DELAY_MS * Math.pow(2, attempt);
        await sleep(backoffMs);
      }
    }
  }

  return {
    item,
    success: false,
    txId: item.txId, // Still include txId for debugging
    error: lastError,
    attempts,
  };
}

/**
 * Upload a batch of pre-signed items via Turbo with concurrency control
 *
 * Items must be pre-signed using signItemsSequentially() to ensure
 * chain integrity (proper prev_tx linking).
 *
 * @param items - Pre-signed items to upload
 * @returns Batch result with succeeded/failed items
 */
export async function uploadSignedBatchViaTurbo(
  items: TurboUploadItem[]
): Promise<TurboBatchResult> {
  const startTime = Date.now();
  const results: TurboUploadResult[] = [];

  // Process items with concurrency control
  const pending: Promise<void>[] = [];
  let nextIndex = 0;

  const processNext = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      const result = await uploadSignedItem(item);
      results.push(result);
    }
  };

  // Start concurrent workers
  const workerCount = Math.min(CONFIG.TURBO_CONCURRENCY, items.length);
  for (let i = 0; i < workerCount; i++) {
    pending.push(processNext());
  }

  await Promise.all(pending);

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  return {
    results,
    succeeded,
    failed,
    totalTimeMs: Date.now() - startTime,
  };
}

/**
 * Legacy function for backwards compatibility.
 * Signs and uploads items, but now does signing sequentially first.
 *
 * @deprecated Use signItemsSequentially + uploadSignedBatchViaTurbo directly
 */
export async function uploadBatchViaTurbo(
  env: Env,
  items: TurboUploadItem[]
): Promise<TurboBatchResult> {
  // This function is deprecated - the new flow signs in process.ts
  // Just upload the pre-signed items
  return uploadSignedBatchViaTurbo(items);
}

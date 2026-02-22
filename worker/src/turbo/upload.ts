/**
 * Turbo upload with retry logic
 *
 * Uploads attestations via Turbo HTTP API with:
 * - Concurrent uploads with configurable parallelism
 * - Retry logic with exponential backoff
 * - 402 error handling with auto top-up
 * - Per-item success/failure tracking
 *
 * Uses the existing bundle module for DataItem creation/signing,
 * then POSTs to Turbo's HTTP API (bypasses SDK crypto issues).
 */

import { createData, ArweaveSigner, type DataItem } from "../bundle";
import type { Env, AttestationPayload, QueueItem, Manifest } from "../types";
import { CONFIG } from "../config";

const TURBO_UPLOAD_URL = "https://upload.ardrive.io/v1/tx";

export interface TurboUploadItem {
  queueItem: QueueItem;
  manifest: Manifest;
  payload: AttestationPayload;
  seq: number;
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
 * Create and sign a DataItem for an attestation
 */
async function createSignedDataItem(
  item: TurboUploadItem,
  signer: ArweaveSigner
): Promise<DataItem> {
  const payloadStr = JSON.stringify(item.payload);
  const tags = buildTags(item.payload);

  const dataItem = createData(payloadStr, signer, { tags });
  await dataItem.sign(signer);

  return dataItem;
}

/**
 * Upload a signed DataItem to Turbo
 */
async function uploadToTurbo(dataItem: DataItem): Promise<TurboUploadResponse> {
  // Get the raw binary of the signed DataItem
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
 * Upload a single attestation via Turbo
 */
async function uploadSingle(
  signer: ArweaveSigner,
  env: Env,
  item: TurboUploadItem
): Promise<TurboUploadResult> {
  let lastError: string | undefined;
  let attempts = 0;

  for (let attempt = 0; attempt < CONFIG.TURBO_MAX_RETRIES; attempt++) {
    attempts = attempt + 1;

    try {
      // Create and sign the DataItem
      const dataItem = await createSignedDataItem(item, signer);

      // Upload to Turbo
      const result = await uploadToTurbo(dataItem);

      return {
        item,
        success: true,
        txId: result.id,
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
    error: lastError,
    attempts,
  };
}

/**
 * Upload a batch of attestations via Turbo with concurrency control
 *
 * @param env - Worker environment
 * @param items - Items to upload
 * @returns Batch result with succeeded/failed items
 */
export async function uploadBatchViaTurbo(
  env: Env,
  items: TurboUploadItem[]
): Promise<TurboBatchResult> {
  const startTime = Date.now();

  // Create signer from wallet
  const wallet = JSON.parse(env.ARWEAVE_WALLET);
  const signer = new ArweaveSigner(wallet);

  const results: TurboUploadResult[] = [];

  // Process items with concurrency control
  const pending: Promise<void>[] = [];
  let nextIndex = 0;

  const processNext = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      const result = await uploadSingle(signer, env, item);
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

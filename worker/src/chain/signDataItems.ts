/**
 * Sequential signing of DataItems for bundling
 *
 * Creates and signs DataItems locally. Each DataItem links to the previous
 * via prev_tx and prev_cid. DataItem IDs are known immediately after signing.
 */

import type {
  Env,
  QueueItem,
  Manifest,
  ChainHead,
  AttestationPayload,
  PendingDataItem,
} from "../types";
import { createData, ArweaveSigner, DataItem } from "../bundle";
import type { Tag } from "../bundle";

/**
 * Build tags array for a DataItem
 */
function buildTags(
  item: QueueItem,
  ver: number,
  seq: number,
  prevTx: string | null
): Tag[] {
  const tags: Tag[] = [
    { name: "Content-Type", value: "application/json" },
    { name: "App-Name", value: "Arke" },
    { name: "Type", value: "attestation" },
    { name: "PI", value: item.entity_id },
    { name: "Ver", value: ver.toString() },
    { name: "CID", value: item.cid },
    { name: "Op", value: item.op },
    { name: "Vis", value: item.vis },
    { name: "Seq", value: seq.toString() },
  ];

  if (prevTx) {
    tags.push({ name: "Prev-TX", value: prevTx });
  }

  return tags;
}

/**
 * Sign a batch of items as DataItems for bundling
 *
 * Each DataItem is signed sequentially, linking to the previous.
 * DataItem IDs are known immediately after signing (before upload).
 *
 * @param env - Worker environment
 * @param items - Queue items to process
 * @param manifests - Map of CID -> Manifest (pre-fetched)
 * @param head - Current chain head
 * @returns Array of signed pending DataItems
 */
export async function signDataItemBatch(
  env: Env,
  items: QueueItem[],
  manifests: Map<string, Manifest>,
  head: ChainHead
): Promise<PendingDataItem[]> {
  if (!env.ARWEAVE_WALLET) {
    throw new Error("ARWEAVE_WALLET secret not configured");
  }

  const wallet = JSON.parse(env.ARWEAVE_WALLET);
  const signer = new ArweaveSigner(wallet);
  const pending: PendingDataItem[] = [];

  // Chain state - starts from current head
  let prevTx = head.tx_id;
  let prevCid = head.cid;
  let seq = head.seq;

  for (const item of items) {
    const manifest = manifests.get(item.cid);
    if (!manifest) {
      console.warn(`[SIGNING] Skipping ${item.cid} - manifest not found`);
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

    // Build tags
    const tags = buildTags(item, manifest.ver, seq, prevTx);

    // Create DataItem
    const dataItem = createData(JSON.stringify(payload), signer, { tags });

    // Sign DataItem - ID is now known!
    await dataItem.sign(signer);
    const txId = dataItem.id;

    pending.push({
      queueItem: item,
      manifest,
      payload,
      dataItem,
      txId,
      seq,
    });

    // Update chain pointers for next iteration
    prevTx = txId;
    prevCid = item.cid;
  }

  return pending;
}

/**
 * Extract DataItem objects from pending items
 */
export function extractDataItems(pending: PendingDataItem[]): DataItem[] {
  return pending.map((p) => p.dataItem as DataItem);
}

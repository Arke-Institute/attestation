/**
 * Sequential pre-signing of transactions
 *
 * Signs all transactions locally (fast) before any uploads.
 * Each transaction links to the previous via prev_tx and prev_cid.
 * TX IDs are deterministic from signatures, so we know the full chain
 * before uploading anything.
 */

import type {
  Env,
  QueueItem,
  Manifest,
  ChainHead,
  AttestationPayload,
  PendingTransaction,
} from "../types";
import { arweave, addTags } from "../arweave";

/**
 * Pre-sign a batch of transactions sequentially
 *
 * This is fast (~1-5ms per transaction) because signing is local.
 * The slow part (upload) is done separately in parallel.
 *
 * @param env - Worker environment
 * @param items - Queue items to process
 * @param manifests - Map of CID -> Manifest (pre-fetched)
 * @param head - Current chain head
 * @returns Array of signed pending transactions
 */
export async function preSignBatch(
  env: Env,
  items: QueueItem[],
  manifests: Map<string, Manifest>,
  head: ChainHead
): Promise<PendingTransaction[]> {
  if (!env.ARWEAVE_WALLET) {
    throw new Error("ARWEAVE_WALLET secret not configured");
  }

  const wallet = JSON.parse(env.ARWEAVE_WALLET);
  const pending: PendingTransaction[] = [];

  // Chain state - starts from current head
  let prevTx = head.tx_id;
  let prevCid = head.cid;
  let seq = head.seq;

  for (const item of items) {
    const manifest = manifests.get(item.cid);
    if (!manifest) {
      // Skip items without manifests (will be marked failed later)
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

    // Create and sign transaction (LOCAL, FAST)
    const tx = await arweave.createTransaction(
      { data: JSON.stringify(payload) },
      wallet
    );

    addTags(tx, item, manifest.ver, seq, prevTx);

    await arweave.transactions.sign(tx, wallet);

    // TX ID is now known (derived from signature)
    const txId = tx.id;

    pending.push({
      queueItem: item,
      manifest,
      payload,
      signedTx: tx,
      txId,
      seq,
    });

    // Update chain pointers for next iteration
    prevTx = txId;
    prevCid = item.cid;
  }

  return pending;
}

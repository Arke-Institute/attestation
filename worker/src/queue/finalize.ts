/**
 * Batch finalization - handle success/failure, update state
 *
 * Key invariant: We only update the chain head to the last SUCCESSFUL upload.
 * This ensures the chain never has gaps, even if some uploads fail.
 */

import type {
  Env,
  PendingTransaction,
  UploadResult,
  ChainHead,
  BatchResult,
} from "../types";
import { updateChainHead } from "../chain/state";

/**
 * Finalize a batch after uploads complete
 *
 * Finds the longest successful prefix of uploads and:
 * 1. Updates chain head to last successful TX
 * 2. Updates KV indexes for succeeded items
 * 3. Deletes succeeded items from queue
 * 4. Re-queues failed items as 'pending' (they'll get new prev_tx next run)
 *
 * @param env - Worker environment
 * @param pending - All pending transactions that were attempted
 * @param uploadResults - Map of TX ID -> upload result
 * @param originalHead - Chain head before this batch
 * @returns BatchResult with succeeded/failed items and new head
 */
export async function finalizeBatch(
  env: Env,
  pending: PendingTransaction[],
  uploadResults: Map<string, UploadResult>,
  originalHead: ChainHead
): Promise<Omit<BatchResult, "stats">> {
  const succeeded: PendingTransaction[] = [];
  const failed: { item: PendingTransaction; error: Error }[] = [];

  // Track the last successful position in the chain
  let lastSuccessfulSeq = originalHead.seq;
  let lastSuccessfulTx = originalHead.tx_id;
  let lastSuccessfulCid = originalHead.cid;

  // Find the longest successful prefix
  // Chain is only valid up to the first failure
  let foundFailure = false;

  for (const p of pending) {
    if (foundFailure) {
      // Everything after first failure is invalid (chain broken)
      failed.push({
        item: p,
        error: new Error("Chain broken by earlier failure"),
      });
      continue;
    }

    const result = uploadResults.get(p.txId);

    if (result?.success) {
      succeeded.push(p);
      lastSuccessfulSeq = p.seq;
      lastSuccessfulTx = p.txId;
      lastSuccessfulCid = p.queueItem.cid;
    } else {
      foundFailure = true;
      failed.push({
        item: p,
        error: result?.error || new Error("Unknown upload error"),
      });
    }
  }

  // Update chain head to last successful TX (if any succeeded)
  if (lastSuccessfulTx && lastSuccessfulTx !== originalHead.tx_id) {
    await updateChainHead(env, lastSuccessfulTx, lastSuccessfulCid!, lastSuccessfulSeq);
  }

  // Parallelize KV writes and D1 operations for speed
  const kvWrites: Promise<void>[] = [];
  const d1Deletes: number[] = [];
  const d1RequeueIds: { id: number; error: string }[] = [];

  // Prepare succeeded items
  for (const p of succeeded) {
    const kvData = JSON.stringify({
      cid: p.queueItem.cid,
      tx: p.txId,
      seq: p.seq,
      ts: new Date(p.queueItem.ts).getTime(),
    });

    // Queue KV writes (parallel)
    kvWrites.push(
      env.ATTESTATION_INDEX.put(
        `attest:${p.queueItem.entity_id}:${p.manifest.ver}`,
        kvData
      )
    );
    kvWrites.push(
      env.ATTESTATION_INDEX.put(
        `attest:${p.queueItem.entity_id}:latest`,
        kvData
      )
    );

    // Collect IDs for batch delete
    d1Deletes.push(p.queueItem.id);

    console.log(
      `[ATTESTATION] ✓ seq=${p.seq} ${p.queueItem.entity_id}:v${p.manifest.ver} -> ${p.txId}`
    );
  }

  // Prepare failed items
  for (const { item, error } of failed) {
    d1RequeueIds.push({ id: item.queueItem.id, error: error.message });
    console.log(
      `[ATTESTATION] ✗ ${item.queueItem.entity_id}:${item.queueItem.cid}: ${error.message}`
    );
  }

  // Execute KV writes in parallel
  await Promise.all(kvWrites);

  // Batch delete succeeded items from queue
  if (d1Deletes.length > 0) {
    const placeholders = d1Deletes.map(() => "?").join(",");
    await env.D1_PROD
      .prepare(`DELETE FROM attestation_queue WHERE id IN (${placeholders})`)
      .bind(...d1Deletes)
      .run();
  }

  // Batch re-queue failed items
  if (d1RequeueIds.length > 0) {
    const now = new Date().toISOString();
    for (const { id, error } of d1RequeueIds) {
      await env.D1_PROD
        .prepare(
          `UPDATE attestation_queue
           SET status = 'pending',
               error_message = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(error, now, id)
        .run();
    }
  }

  return {
    succeeded,
    failed,
    newHead: lastSuccessfulTx
      ? {
          txId: lastSuccessfulTx,
          cid: lastSuccessfulCid!,
          seq: lastSuccessfulSeq,
        }
      : null,
  };
}

/**
 * Arweave client setup and transaction helpers
 */

import Arweave from "@irys/arweave";
import type { QueueItem } from "./types";

// Arweave client instance
export const arweave = new Arweave({ url: "https://arweave.net" });

/**
 * Add standard tags to an Arweave transaction for queryability
 */
export function addTags(
  tx: Awaited<ReturnType<typeof arweave.createTransaction>>,
  item: QueueItem,
  ver: number,
  seq: number,
  prevTx: string | null
): void {
  tx.addTag("Content-Type", "application/json");
  tx.addTag("App-Name", "Arke");
  tx.addTag("Type", "attestation");
  tx.addTag("PI", item.entity_id);
  tx.addTag("Ver", ver.toString());
  tx.addTag("CID", item.cid);
  tx.addTag("Op", item.op);
  tx.addTag("Vis", item.vis);
  tx.addTag("Seq", seq.toString());

  if (prevTx) {
    tx.addTag("Prev-TX", prevTx);
  }
}

/**
 * Chain state management - D1 operations for chain head
 */

import type { Env, ChainHead } from "../types";

/**
 * Get the current chain head from D1
 * Returns genesis state if no head exists
 */
export async function getChainHead(env: Env): Promise<ChainHead> {
  const result = await env.D1_PROD.prepare(
    "SELECT tx_id, cid, seq FROM chain_state WHERE key = 'head'"
  ).first<ChainHead>();

  if (!result) {
    // Genesis state
    return { tx_id: null, cid: null, seq: 0 };
  }

  return result;
}

/**
 * Update the chain head in D1
 * CRITICAL: This must succeed for chain integrity
 */
export async function updateChainHead(
  env: Env,
  txId: string,
  cid: string,
  seq: number
): Promise<void> {
  await env.D1_PROD.prepare(
    "UPDATE chain_state SET tx_id = ?, cid = ?, seq = ?, updated_at = ? WHERE key = 'head'"
  )
    .bind(txId, cid, seq, new Date().toISOString())
    .run();
}

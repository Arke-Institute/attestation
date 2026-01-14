/**
 * Chain state management - D1 operations for chain head
 *
 * Supports multiple chain keys for test isolation:
 * - 'head' = production chain
 * - 'test_head' = isolated test chain
 */

import type { Env, ChainHead } from "../types";

export const CHAIN_KEY_PROD = "head";
export const CHAIN_KEY_TEST = "test_head";

/**
 * Get the current chain head from D1
 * Returns genesis state if no head exists
 *
 * @param env - Worker environment
 * @param chainKey - Chain key to use (default: 'head' for production)
 */
export async function getChainHead(
  env: Env,
  chainKey: string = CHAIN_KEY_PROD
): Promise<ChainHead> {
  const result = await env.D1_PROD.prepare(
    "SELECT tx_id, cid, seq FROM chain_state WHERE key = ?"
  )
    .bind(chainKey)
    .first<ChainHead>();

  if (!result) {
    // Genesis state
    return { tx_id: null, cid: null, seq: 0 };
  }

  return result;
}

/**
 * Update the chain head in D1
 * CRITICAL: This must succeed for chain integrity
 *
 * @param env - Worker environment
 * @param txId - New head transaction ID
 * @param cid - New head CID
 * @param seq - New sequence number
 * @param chainKey - Chain key to use (default: 'head' for production)
 */
export async function updateChainHead(
  env: Env,
  txId: string,
  cid: string,
  seq: number,
  chainKey: string = CHAIN_KEY_PROD
): Promise<void> {
  // Use upsert to handle both existing and new chain keys
  await env.D1_PROD.prepare(
    `INSERT INTO chain_state (key, tx_id, cid, seq, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       tx_id = excluded.tx_id,
       cid = excluded.cid,
       seq = excluded.seq,
       updated_at = excluded.updated_at`
  )
    .bind(chainKey, txId, cid, seq, new Date().toISOString())
    .run();
}

/**
 * Reset a chain head to genesis state (for testing)
 */
export async function resetChainHead(
  env: Env,
  chainKey: string = CHAIN_KEY_TEST
): Promise<void> {
  await env.D1_PROD.prepare(
    `INSERT INTO chain_state (key, tx_id, cid, seq, updated_at)
     VALUES (?, NULL, NULL, 0, ?)
     ON CONFLICT(key) DO UPDATE SET
       tx_id = NULL,
       cid = NULL,
       seq = 0,
       updated_at = excluded.updated_at`
  )
    .bind(chainKey, new Date().toISOString())
    .run();
}

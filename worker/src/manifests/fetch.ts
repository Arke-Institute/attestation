/**
 * Parallel manifest fetching from KV
 *
 * Manifests are stored in KV_MANIFESTS with keys: prod:{cid}
 * This namespace is shared with the arke-v1 API.
 */

import type { Env, QueueItem, Manifest } from "../types";

/**
 * Fetch manifests for multiple queue items in parallel
 * Returns a Map of CID -> Manifest for items that were successfully fetched
 * Items that fail to fetch are logged but not included in the result
 */
export async function fetchManifestsParallel(
  env: Env,
  items: QueueItem[]
): Promise<Map<string, Manifest>> {
  const results = new Map<string, Manifest>();

  // Fetch all manifests in parallel from KV
  const fetches = items.map(async (item) => {
    try {
      // KV keys are prefixed with "prod:" for production manifests
      const kvKey = `prod:${item.cid}`;
      const stored = await env.KV_MANIFESTS.get(kvKey);

      if (!stored) {
        console.error(`[MANIFESTS] Not found in KV: ${item.cid}`);
        return null;
      }

      const manifest = JSON.parse(stored) as Manifest;

      // Validate manifest has required ver field
      if (typeof manifest.ver !== "number") {
        console.error(`[MANIFESTS] Missing ver field: ${item.cid}`);
        return null;
      }

      return { cid: item.cid, manifest };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[MANIFESTS] Failed to fetch ${item.cid}: ${msg}`);
      return null;
    }
  });

  const fetchResults = await Promise.all(fetches);

  // Collect successful fetches
  for (const result of fetchResults) {
    if (result) {
      results.set(result.cid, result.manifest);
    }
  }

  return results;
}

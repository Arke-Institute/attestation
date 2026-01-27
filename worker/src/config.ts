/**
 * Configuration constants for the attestation worker
 */

export const CONFIG = {
  // Batch size - max items to fetch per cycle
  // Limited by Cloudflare's 1000 subrequest limit per invocation:
  // Each item needs 1 KV read + 2 KV writes = 3 subrequests
  // 300 items × 3 = 900 subrequests, leaving headroom for D1/chain ops
  BATCH_SIZE: 300,

  // Cron runs every 60s, use 55s of that window (5s buffer for cleanup)
  MAX_PROCESS_TIME_MS: 55_000,

  // Max retry attempts before marking as abandoned
  MAX_RETRIES: 5,

  // Per-upload timeout
  UPLOAD_TIMEOUT_MS: 30_000,

  // Threshold for cleanup job (items stuck in 'signing' state)
  STUCK_THRESHOLD_MS: 10 * 60 * 1000, // 10 minutes

  // ==========================================================================
  // Bundle Configuration
  // ==========================================================================

  // Size threshold for creating a bundle (in bytes)
  // We want to be ABOVE 256KB to get efficient per-byte rates
  // At 300KB we're paying ~$0.007 for ~300 manifests instead of ~$1.07 unbundled
  BUNDLE_SIZE_THRESHOLD: 300 * 1024, // 300KB

  // Time threshold for bundle creation (in ms)
  // If we don't hit size threshold, upload after this much time
  // Ensures low-traffic periods don't wait forever
  BUNDLE_TIME_THRESHOLD_MS: 10 * 60 * 1000, // 10 minutes

  // Enable bundling (can disable for fallback to L1 uploads)
  USE_BUNDLING: true,
} as const;

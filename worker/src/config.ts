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

  // Maximum bundle size (in bytes)
  // Large bundles (40MB+) fail to seed on Arweave gateways
  // 10MB is safe and allows for network variance
  MAX_BUNDLE_SIZE_BYTES: 10 * 1024 * 1024, // 10MB

  // Time threshold for bundle creation (in ms)
  // If we don't hit size threshold, upload after this much time
  // Ensures low-traffic periods don't wait forever
  BUNDLE_TIME_THRESHOLD_MS: 10 * 60 * 1000, // 10 minutes

  // Enable bundling (can disable for fallback to L1 uploads)
  USE_BUNDLING: true,

  // ==========================================================================
  // Bundle Verification Configuration
  // ==========================================================================

  // Grace period before checking if bundle is seeded (gives time for propagation)
  BUNDLE_SEED_GRACE_PERIOD_MS: 10 * 60 * 1000, // 10 minutes

  // Timeout after which bundle is declared failed if still not seeded
  BUNDLE_SEED_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes

  // How long to keep bundle records for debugging
  BUNDLE_RETENTION_MS: 24 * 60 * 60 * 1000, // 24 hours

  // HTTP timeout for HEAD requests when checking seeding status
  BUNDLE_VERIFY_TIMEOUT_MS: 5000, // 5 seconds

  // ==========================================================================
  // Wallet Balance Configuration
  // ==========================================================================

  // Warning threshold - send alert but continue processing
  BALANCE_WARNING_THRESHOLD_AR: 2,

  // Critical threshold - stop processing to avoid wasted cycles
  BALANCE_CRITICAL_THRESHOLD_AR: 0.05,
} as const;

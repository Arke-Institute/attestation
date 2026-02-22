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
  // Turbo Configuration (Primary - recommended)
  // ==========================================================================

  // Use Turbo for uploads (recommended over bundling)
  // Turbo provides immediate data availability and handles bundling server-side
  USE_TURBO: true,

  // Concurrent uploads - sweet spot from stress testing
  // Higher values increase throughput but may hit rate limits
  TURBO_CONCURRENCY: 50,

  // Retry configuration for failed uploads
  TURBO_MAX_RETRIES: 3,
  TURBO_RETRY_DELAY_MS: 1000,

  // Free tier limit (uploads under this size are free)
  // Items over this size will get 402 errors if no Turbo credits
  TURBO_FREE_LIMIT_BYTES: 100 * 1024, // 100 KiB

  // ==========================================================================
  // Bundle Configuration (Legacy - deprecated)
  // ==========================================================================

  // @deprecated Use USE_TURBO instead - bundling no longer works reliably
  // as AR-IO gateways have disabled unbundling of L1 ANS-104 bundles
  USE_BUNDLING: false,

  // Size threshold for creating a bundle (in bytes)
  BUNDLE_SIZE_THRESHOLD: 300 * 1024, // 300KB

  // Maximum bundle size (in bytes)
  MAX_BUNDLE_SIZE_BYTES: 10 * 1024 * 1024, // 10MB

  // Time threshold for bundle creation (in ms)
  BUNDLE_TIME_THRESHOLD_MS: 10 * 60 * 1000, // 10 minutes

  // ==========================================================================
  // Bundle Verification Configuration (Legacy)
  // ==========================================================================

  BUNDLE_SEED_GRACE_PERIOD_MS: 10 * 60 * 1000, // 10 minutes
  BUNDLE_SEED_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes
  BUNDLE_RETENTION_MS: 24 * 60 * 60 * 1000, // 24 hours
  BUNDLE_VERIFY_TIMEOUT_MS: 5000, // 5 seconds

  // ==========================================================================
  // Wallet Balance Configuration
  // ==========================================================================

  // Warning threshold - send alert but continue processing
  BALANCE_WARNING_THRESHOLD_AR: 2,

  // Critical threshold - stop processing to avoid wasted cycles
  BALANCE_CRITICAL_THRESHOLD_AR: 0.05,
} as const;

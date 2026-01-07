/**
 * Configuration constants for the attestation worker
 */

export const CONFIG = {
  // Batch size for parallel processing
  // Can increase to 100-200 if needed (stay under 1000 subrequests: ~4N + 2)
  // At 50: ~26s/batch, ~166k/day | At 100: ~40s/batch, ~216k/day (estimated)
  BATCH_SIZE: 50,

  // Cron runs every 60s, use 55s of that window (5s buffer for cleanup)
  MAX_PROCESS_TIME_MS: 55_000,

  // Max retry attempts before marking as abandoned
  MAX_RETRIES: 5,

  // Per-upload timeout
  UPLOAD_TIMEOUT_MS: 30_000,

  // Threshold for cleanup job (items stuck in 'signing' state)
  STUCK_THRESHOLD_MS: 10 * 60 * 1000, // 10 minutes
} as const;

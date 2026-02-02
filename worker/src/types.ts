/**
 * Shared types for the attestation worker
 */

export interface Env {
  D1_PROD: D1Database;
  KV_MANIFESTS: KVNamespace; // Shared with arke-v1 API - keys are prod:{cid}
  ATTESTATION_INDEX: KVNamespace;
  ARWEAVE_WALLET: string;
  ADMIN_SECRET?: string; // Optional secret for admin endpoints
  ALERT_WEBHOOK_URL?: string; // Optional Slack/Discord webhook for alerts
}

export interface ChainHead {
  tx_id: string | null;
  cid: string | null;
  seq: number;
}

export interface QueueItem {
  id: number;
  entity_id: string;
  cid: string;
  op: string;
  vis: string;
  ts: string;
  created_at: string;
  status: string;
  retry_count: number;
  error_message: string | null;
}

export interface Manifest {
  ver: number;
  [key: string]: unknown;
}

export interface AttestationPayload {
  attestation: {
    pi: string;
    ver: number;
    cid: string;
    op: string;
    vis: string;
    ts: number;
    prev_tx: string | null;
    prev_cid: string | null;
    seq: number;
  };
  manifest: Manifest;
}

export interface ProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  duration: number;
}

/**
 * Record stored in KV for attestation lookup
 * The bundled field indicates this was uploaded via ANS-104 bundling.
 */
export interface AttestationRecord {
  cid: string;
  tx: string; // DataItem ID (works same as L1 TX ID)
  seq: number;
  ts: number;
  bundled?: boolean; // true = self-bundled DataItem
}

// =============================================================================
// Bundling Types
// =============================================================================

/**
 * A signed DataItem pending bundle upload
 */
export interface PendingDataItem {
  queueItem: QueueItem;
  manifest: Manifest;
  payload: AttestationPayload;
  dataItem: unknown; // DataItem from bundle module
  txId: string; // DataItem ID (known after signing)
  seq: number;
}

// =============================================================================
// Legacy Types (kept for fallback)
// =============================================================================

/**
 * A transaction that has been signed but not yet uploaded
 * @deprecated Use PendingDataItem for bundled uploads
 */
export interface PendingTransaction {
  queueItem: QueueItem;
  manifest: Manifest;
  payload: AttestationPayload;
  signedTx: unknown; // Arweave Transaction type
  txId: string;
  seq: number;
}

/**
 * Result of a single upload attempt
 */
export interface UploadResult {
  txId: string;
  success: boolean;
  error?: Error;
}

/**
 * Result of processing a batch
 */
export interface BatchResult {
  succeeded: PendingTransaction[];
  failed: { item: PendingTransaction; error: Error }[];
  newHead: { txId: string; cid: string; seq: number } | null;
  stats: {
    fetchTimeMs: number;
    signTimeMs: number;
    uploadTimeMs: number;
    finalizeTimeMs: number;
  };
}

// =============================================================================
// Bundle Verification Types
// =============================================================================

/**
 * A bundle pending seeding verification
 */
export interface PendingBundle {
  bundleTxId: string;
  entityCids: Record<string, string>; // entityId -> cid mapping
  itemCount: number;
  uploadedAt: number;
  checkCount: number;
  verified?: boolean;
  verifiedAt?: number;
  failed?: boolean;
  failedAt?: number;
}

/**
 * Result of bundle verification check
 */
export interface BundleVerifyResult {
  checked: number;
  verified: number;
  failed: number;
  pending: number;
  requeuedEntities: number;
}

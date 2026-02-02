# Self-Healing Attestation System - Implementation Plan

## Overview
Add chain verification, automatic healing, and alerting to prevent and recover from seeding failures.

---

## Phase 1: Data Model & Types

### 1.1 Add new types to `src/types.ts`
- [ ] Add `ALERT_WEBHOOK_URL?: string` to Env interface
- [ ] Add `VerificationState` interface:
  ```typescript
  interface VerificationState {
    lastVerifiedSeq: number;
    lastVerifiedAt: string;
    lastWalkDepth: number;
  }
  ```
- [ ] Add `BundleRecord` interface:
  ```typescript
  interface BundleRecord {
    bundleTxId: string;
    dataItemIds: string[];
    uploadedAt: string;
    verified: boolean;
    verifiedAt?: string;
  }
  ```
- [ ] Add `BrokenAttestation` interface:
  ```typescript
  interface BrokenAttestation {
    txId: string;
    entityId: string;
    cid: string;
    detectedAt: string;
    healAttempts: number;
    healedAt?: string;
    failedAt?: string;  // Set when max heal attempts reached
  }
  ```
- [ ] Add `VerificationResult` interface for return values

### 1.2 Add config constants to `src/config.ts`
- [ ] `VERIFY_CHAIN_DEPTH: 50` - How far back to walk chain
- [ ] `VERIFY_BUNDLE_GRACE_PERIOD_MS: 30 * 60 * 1000` - 30 min before declaring seeding failure
- [ ] `VERIFY_BUNDLE_RETENTION_MS: 7 * 24 * 60 * 60 * 1000` - Keep bundle records for 7 days
- [ ] `MAX_HEAL_ATTEMPTS: 3` - Max times to try healing an attestation
- [ ] `VERIFY_FETCH_TIMEOUT_MS: 5000` - Timeout for Arweave fetches

---

## Phase 2: Verification State Management

### 2.1 Create `src/verify/state.ts`
- [ ] `getVerificationState(env): Promise<VerificationState>`
  - Read from KV key `verify:state`
  - Return defaults if not exists
- [ ] `updateVerificationState(env, state): Promise<void>`
  - Write to KV key `verify:state`
- [ ] `getBundleRecords(env): Promise<BundleRecord[]>`
  - Read from KV key `verify:bundles`
  - Return empty array if not exists
- [ ] `saveBundleRecords(env, records): Promise<void>`
  - Write to KV key `verify:bundles`
  - Prune records older than VERIFY_BUNDLE_RETENTION_MS
- [ ] `addBundleRecord(env, record): Promise<void>`
  - Append to existing records, prune old ones
- [ ] `getBrokenAttestations(env): Promise<BrokenAttestation[]>`
  - Read from KV key `verify:broken`
- [ ] `saveBrokenAttestations(env, broken): Promise<void>`
  - Write to KV key `verify:broken`

---

## Phase 3: Chain Walker

### 3.1 Create `src/verify/chainWalker.ts`
- [ ] `fetchAttestation(txId): Promise<AttestationData | null>`
  - Fetch from `https://arweave.net/{txId}`
  - Follow redirects
  - Parse JSON, extract attestation fields
  - Return null on 404 or timeout
- [ ] `walkChain(env, startTxId, depth): Promise<WalkResult>`
  - Walk backward from startTxId following prev_tx
  - Stop at genesis (prev_tx = null) or depth limit
  - Return { verified: number, broken: BrokenLink[] }
- [ ] `verifyChainIntegrity(env): Promise<ChainVerificationResult>`
  - Get chain head from `chain:head`
  - Get last verified state
  - Only walk from head to lastVerifiedSeq (incremental)
  - Update verification state
  - Return any broken links found

---

## Phase 4: Bundle Verifier

### 4.1 Modify `src/upload/bundle.ts`
- [ ] After successful upload, call `addBundleRecord(env, record)`
  - Store bundleTxId, dataItemIds, uploadedAt, verified=false
  - This happens BEFORE finalization

### 4.2 Create `src/verify/bundleVerifier.ts`
- [ ] `verifyBundle(bundleTxId): Promise<boolean>`
  - Try to fetch bundle data from gateway
  - Return true if accessible, false if 404
- [ ] `verifyPendingBundles(env): Promise<BundleVerificationResult>`
  - Get all bundle records where verified=false
  - For each, check if past grace period
  - If past grace period and still 404, mark as failed
  - If accessible, mark verified=true
  - Return { verified: string[], failed: string[] }

---

## Phase 5: Self-Healer

### 5.1 Create `src/verify/healer.ts`
- [ ] `findEntityByTxId(txId): Promise<string | null>`
  - Query GraphQL for transaction tags
  - Extract PI (entity ID) from tags
- [ ] `canHealAttestation(env, broken): Promise<boolean>`
  - Check heal attempts < MAX_HEAL_ATTEMPTS
  - Check entity manifest exists in KV_MANIFESTS
  - Check not already in attestation_queue
- [ ] `healAttestation(env, broken): Promise<boolean>`
  - Get entity's current CID from attestation record
  - Get manifest from KV_MANIFESTS
  - Insert into attestation_queue
  - Increment healAttempts in broken record
  - Return true on success
- [ ] `healBrokenAttestations(env): Promise<HealResult>`
  - Get all broken attestations
  - Filter to those not healed and attempts < max
  - Try to heal each
  - Mark as failedAt if max attempts reached
  - Return { healed: number, failed: number, permanent: number }

---

## Phase 6: Alert System

### 6.1 Create `src/verify/alerts.ts`
- [ ] `sendAlert(env, alert): Promise<void>`
  - Check if ALERT_WEBHOOK_URL is configured
  - Format message based on alert type
  - POST to webhook URL
  - Log if webhook not configured
- [ ] Alert types:
  - `chain_break` - Chain integrity issue detected
  - `seeding_failure` - Bundle failed to seed after grace period
  - `heal_failure` - Attestation could not be healed after max attempts
  - `stuck_items` - Items stuck in signing > 30 min (existing issue)

### 6.2 Alert message format
```typescript
{
  text: "🚨 Arke Attestation Alert",
  blocks: [
    { type: "header", text: "Chain Break Detected" },
    { type: "section", text: "Details..." },
    { type: "context", text: "Timestamp, affected items, etc." }
  ]
}
```

---

## Phase 7: Orchestration

### 7.1 Create `src/verify/index.ts`
- [ ] `runVerification(env): Promise<VerificationSummary>`
  - Run chain verification
  - Run bundle verification
  - Run healing for any broken items
  - Collect all alerts
  - Send batched alert if any issues
  - Return summary for logging/health endpoint

### 7.2 Update `wrangler.jsonc`
- [ ] Add cron: `*/10 * * * *` (every 10 minutes)

### 7.3 Update `src/index.ts`
- [ ] Import verification module
- [ ] Add handler for `*/10 * * * *` cron
- [ ] Add verification stats to health endpoint:
  ```typescript
  verification: {
    lastRun: string,
    chainVerified: number,
    brokenItems: number,
    pendingHeals: number
  }
  ```

---

## Phase 8: Testing

### 8.1 Manual verification
- [ ] Deploy and check health endpoint shows verification stats
- [ ] Verify chain walker runs without errors
- [ ] Verify bundle records are being stored after uploads
- [ ] Test alert webhook (if configured)

### 8.2 Edge cases to verify
- [ ] Empty chain (genesis state)
- [ ] Entity manifest deleted before heal
- [ ] Entity already in queue when trying to heal
- [ ] Webhook URL not configured (should log, not crash)
- [ ] Network timeouts during verification

---

## File Structure

```
src/
├── verify/
│   ├── index.ts        # Main orchestration
│   ├── state.ts        # KV state management
│   ├── chainWalker.ts  # Chain integrity verification
│   ├── bundleVerifier.ts # Bundle seeding verification
│   ├── healer.ts       # Self-healing logic
│   └── alerts.ts       # Webhook alerting
├── types.ts            # Updated with new interfaces
├── config.ts           # Updated with new constants
└── index.ts            # Updated with new cron handler
```

---

## Estimated Changes

| File | Changes |
|------|---------|
| `src/types.ts` | +30 lines (new interfaces) |
| `src/config.ts` | +15 lines (new constants) |
| `src/verify/state.ts` | ~80 lines (new file) |
| `src/verify/chainWalker.ts` | ~100 lines (new file) |
| `src/verify/bundleVerifier.ts` | ~60 lines (new file) |
| `src/verify/healer.ts` | ~120 lines (new file) |
| `src/verify/alerts.ts` | ~50 lines (new file) |
| `src/verify/index.ts` | ~60 lines (new file) |
| `src/upload/bundle.ts` | +10 lines (add bundle record) |
| `src/index.ts` | +20 lines (cron handler, health) |
| `wrangler.jsonc` | +1 line (new cron) |
| **Total** | ~550 lines |

---

## Rollout Plan

1. Deploy with verification in "monitor only" mode (no healing)
2. Verify logs show correct detection
3. Enable healing with alerts
4. Configure webhook for real-time alerts
5. Monitor for 24-48 hours before considering stable

---

## Open Items

- [ ] Decide: Should we also verify data availability (not just tx exists)?
  - Current plan: Verify tx exists + can fetch attestation JSON
  - Alternative: Also verify raw bundle data is fetchable (more thorough but slower)

- [ ] Decide: Alert batching window?
  - Current plan: One alert per 10-min verification run
  - Alternative: Aggregate alerts over longer period (1 hour?)

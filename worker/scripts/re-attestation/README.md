# Re-Attestation Scripts

These scripts fix attestations that failed due to AR-IO gateways disabling L1 ANS-104 unbundling.

## Problem

- Attestations from seq 296737 to 308366 are indexed in GraphQL but data is inaccessible
- This is because the DataItems were bundled in L1 transactions that gateways no longer unbundle
- ~11,630 attestations are affected

## Solution

1. Reset chain head to last known good (seq 296736)
2. Extract affected entity IDs
3. Re-queue entities for attestation via Turbo (which works)
4. Verify re-attestation succeeded

## Prerequisites

```bash
# Set Cloudflare credentials for KV access (step 1)
export CF_ACCOUNT_ID=your_account_id
export CF_API_TOKEN=your_api_token

# Ensure wrangler is configured (step 3)
wrangler whoami
```

## Usage

### Step 1: Reset Chain Head

```bash
# Preview changes
npx tsx scripts/re-attestation/01-reset-chain-head.ts --dry-run

# Apply changes
npx tsx scripts/re-attestation/01-reset-chain-head.ts
```

### Step 2: Extract Affected Entities

```bash
npx tsx scripts/re-attestation/02-extract-affected-entities.ts
```

This creates `affected-entities.json` with the list of entities to re-attest.

### Step 3: Re-Queue Entities

```bash
# Preview changes
npx tsx scripts/re-attestation/03-requeue-entities.ts --dry-run

# Apply changes (fetches current CIDs from API and inserts into queue)
npx tsx scripts/re-attestation/03-requeue-entities.ts

# Skip API fetch and use CIDs from broken attestations
npx tsx scripts/re-attestation/03-requeue-entities.ts --skip-fetch
```

### Step 4: Verify Re-Attestation

```bash
# Verify 10 random entities
npx tsx scripts/re-attestation/04-verify-reattestation.ts

# Verify more
npx tsx scripts/re-attestation/04-verify-reattestation.ts 50
```

## Monitoring

Check queue status:
```bash
curl -s https://arke-attestation.nick-chimicles-professional.workers.dev/ | jq '.queue'
```

Expected processing time: ~4 minutes (11,630 items at 50/sec)

## Files Created

- `affected-entities.json` - List of affected entity IDs with details
- `entities-to-queue.json` - Entities actually queued (after API validation)

## Rollback

If something goes wrong, the old attestations are still in GraphQL (just inaccessible).
The chain can be re-pointed to any valid attestation by updating `chain:head` in KV.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Arke Attestation is a system for uploading entity manifests to Arweave for permanent, immutable storage. It consists of:

1. **Cloudflare Worker** (`worker/`) - Processes an attestation queue, fetching manifests from R2 and uploading them to Arweave
2. **CLI Scripts** (`scripts/`) - Local utilities for wallet management and manual uploads

## Commands

### Worker Development (in `worker/` directory)
```bash
npm run dev          # Start local dev server (run in background)
npm run deploy       # Deploy to Cloudflare
wrangler tail        # View logs (must start BEFORE triggering requests)
```

### Local Scripts (from root directory)
```bash
npm run generate-wallet  # Create new Arweave wallet (saved to wallet.json)
npm run check-balance    # Check wallet AR balance
npm run upload           # Upload demo data (or pass file path)
npm run upload <file>    # Upload specific file to Arweave
```

## Architecture

### Worker Flow
1. Cron trigger (every minute) calls `processQueue()`
2. Fetches pending items from D1 `attestation_queue` table
3. For each item: fetches manifest from R2 by CID, uploads to Arweave with tags
4. On success: stores TX ID in KV (`ATTESTATION_INDEX`), deletes from queue
5. On failure: marks as failed with retry count (max 5 retries)

### Bindings (wrangler.jsonc)
- `D1_PROD` - D1 database with `attestation_queue` table (PROD only)
- `R2_MANIFESTS` - R2 bucket containing entity manifests
- `ATTESTATION_INDEX` - KV namespace for attestation TX lookup
- `ARWEAVE_WALLET` - Secret containing JWK wallet JSON

### Worker Endpoints
- `GET /` - Health check with queue stats
- `POST /trigger` - Manual queue processing trigger
- `POST /test?batch=N` - Test processing with metrics (synchronous)
- `POST /seed?count=N` - Seed test data for performance testing
- `POST /test-upload?count=N` - Raw Arweave upload performance test
- `POST /retry` - Manually trigger retry of failed items

### Queue States
- `pending` - Awaiting processing
- `uploading` - Currently being uploaded
- `failed` - Upload failed (will retry up to 5 times)

### Arweave Tags
All uploads are tagged with: `App-Name: Arke`, `Type: manifest`, `PI` (entity ID), `Ver`, `CID`, `Op`, `Vis`, and optionally `Prev-CID`.

## Cloudflare Notes
- Always use `wrangler.jsonc` (not `.toml`) for configuration
- For logs: run `wrangler tail` BEFORE making requests (no historical logs)
- Run `npm run dev` in background when developing locally

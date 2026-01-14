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

## Local Development Setup

### Secrets (.dev.vars)
Copy the example file and fill in values:
```bash
cd worker
cp .dev.vars.example .dev.vars
```

Required secrets in `.dev.vars`:
- `ARWEAVE_WALLET` - JWK wallet JSON (single line)
- `ADMIN_SECRET` - Bearer token for admin endpoints (generate with `openssl rand -base64 32`)

**Never commit `.dev.vars`** - it's gitignored.

### Production Secrets
Set via wrangler:
```bash
wrangler secret put ARWEAVE_WALLET  # Paste JWK JSON
wrangler secret put ADMIN_SECRET    # Paste generated secret
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
- `ADMIN_SECRET` - Secret for admin endpoint authentication

### Worker Endpoints
- `GET /` - Health check with queue stats (public)
- `POST /trigger` - Manual queue processing (requires auth)
- `POST /test-bundle?count=N` - Bundle test with isolated chain (requires auth)

**Authentication**: Admin endpoints require `Authorization: Bearer <ADMIN_SECRET>` header.

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

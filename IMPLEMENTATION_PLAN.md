# Attestation Worker Implementation Plan

## Current State

The attestation worker has:
- Basic HTTP upload endpoint (`POST /upload`)
- Arweave wallet configured (`ARWEAVE_WALLET` secret)
- `@irys/arweave` SDK for direct Arweave uploads
- Minimal wrangler config (no bindings, no crons)

## Target State

Transform into a scheduled queue processor that:
1. Reads pending items from D1 `attestation_queue` table
2. Fetches full manifests from arke-v1
3. Uploads to Arweave with proper tags
4. Stores TX IDs in `ATTESTATION_INDEX` KV
5. Cleans up queue on success, retries on failure

---

## Implementation Checklist

### Phase 1: Configuration Updates

- [ ] **Update wrangler.jsonc**
  - Add D1 bindings (D1_PROD, D1_TEST)
  - Add KV binding (ATTESTATION_INDEX)
  - Add service binding (ARKE_V1_WORKER) for manifest fetching
  - Add cron triggers
  - Update name to `arke-attestation`

- [ ] **Set secrets**
  - Verify ARWEAVE_WALLET is set
  - Add any additional config vars needed

### Phase 2: Core Implementation

- [ ] **Add scheduled handler**
  - `scheduled()` export for cron triggers
  - Route different crons to appropriate handlers

- [ ] **Implement queue processor**
  - Query pending items from D1 (limit 50)
  - Mark as 'uploading' before processing
  - Handle both PROD and TEST databases

- [ ] **Implement manifest fetcher**
  - Fetch via service binding to arke-v1
  - Or direct R2 access if service binding is complex
  - Extract `ver` from manifest

- [ ] **Adapt Arweave upload**
  - Create payload: `{attestation: {...}, manifest: {...}}`
  - Add proper tags (App-Name, Type, PI, Ver, CID, Op, Vis, Prev-CID)
  - Handle upload errors gracefully

- [ ] **Implement KV index update**
  - Key: `attest:{pi}:{ver}`
  - Value: `{cid, tx, ts}`

- [ ] **Implement cleanup**
  - Delete from queue on success
  - Mark failed with error message and increment retry_count

### Phase 3: Retry Logic

- [ ] **Daily retry handler**
  - Reset failed items (retry_count < 5) back to pending
  - Log abandoned items (retry_count >= 5)

- [ ] **Stuck item detection**
  - Items stuck in 'uploading' for > 10 minutes → reset to pending

### Phase 4: Testing & Deployment

- [ ] **Local testing**
  - Test with wrangler dev
  - Verify queue processing
  - Test error handling

- [ ] **Deploy and monitor**
  - Deploy worker
  - Monitor logs
  - Verify KV population

---

## Detailed Changes

### 1. wrangler.jsonc

```jsonc
{
  "name": "arke-attestation",
  "main": "src/index.js",
  "compatibility_date": "2024-09-23",
  "compatibility_flags": ["nodejs_compat"],

  // D1 database (PROD only - test entities are not attested)
  "d1_databases": [
    {
      "binding": "D1_PROD",
      "database_name": "arke-prod",
      "database_id": "ca15318b-69fe-45d7-a1d4-e20aebe2b1f5"
    }
  ],

  // KV namespace for attestation index
  "kv_namespaces": [
    {
      "binding": "ATTESTATION_INDEX",
      "id": "8637de60b50f4572b1ba7f312479a4be"
    }
  ],

  // R2 for direct manifest fetching (PROD only)
  "r2_buckets": [
    {
      "binding": "R2_MANIFESTS",
      "bucket_name": "arke-manifests-prod"
    }
  ],

  // Scheduled triggers
  "triggers": {
    "crons": [
      "* * * * *",     // Every minute: process queue
      "0 4 * * *"      // Daily 4 AM: retry failed items
    ]
  }
}
```

**Note:** Test network entities (II-prefixed IDs) are NOT attested. The arke-v1 API skips attestation queue inserts for test entities.

### 2. src/index.js (Rewrite)

```javascript
import Arweave from '@irys/arweave';

const arweave = new Arweave({ url: 'https://arweave.net' });

// Constants
const BATCH_SIZE = 50;
const MAX_RETRIES = 5;

export default {
  // Keep existing fetch handler for health checks
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return Response.json({
        status: 'ok',
        message: 'Arke attestation worker',
        version: '2.0.0'
      });
    }

    // Manual trigger endpoint (for testing)
    if (url.pathname === '/trigger' && request.method === 'POST') {
      ctx.waitUntil(processQueue(env));
      return Response.json({ message: 'Queue processing triggered' });
    }

    return new Response('Not found', { status: 404 });
  },

  // Scheduled handler for cron triggers
  async scheduled(event, env, ctx) {
    const trigger = event.cron;

    if (trigger === '* * * * *') {
      // Every minute: process attestation queue
      await processQueue(env);
    }

    if (trigger === '0 4 * * *') {
      // Daily: retry failed items, cleanup stuck
      await retryFailedItems(env);
      await cleanupStuckItems(env);
    }
  }
};

// =============================================================================
// Queue Processing (PROD only - test entities are not attested)
// =============================================================================

async function processQueue(env) {
  console.log('[ATTESTATION] Starting queue processing');

  const db = env.D1_PROD;
  const r2 = env.R2_MANIFESTS;

  // Fetch pending items
  const pending = await db.prepare(`
    SELECT * FROM attestation_queue
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(BATCH_SIZE).all();

  if (pending.results.length === 0) {
    return;
  }

  console.log(`[ATTESTATION] Processing ${pending.results.length} items`);

  for (const record of pending.results) {
    try {
      await processQueueItem(record, db, r2, env);
    } catch (error) {
      console.error(`[ATTESTATION] Failed ${record.entity_id}:${record.cid}:`, error.message);

      await db.prepare(`
        UPDATE attestation_queue
        SET status = 'failed',
            retry_count = retry_count + 1,
            error_message = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(String(error.message || error), new Date().toISOString(), record.id).run();
    }
  }
}

async function processQueueItem(record, db, r2, env) {
  const now = new Date().toISOString();

  // 1. Mark as uploading
  await db.prepare(`
    UPDATE attestation_queue SET status = 'uploading', updated_at = ? WHERE id = ?
  `).bind(now, record.id).run();

  // 2. Fetch manifest from R2
  // Key is just the CID (content-addressed)
  const r2Object = await r2.get(record.cid);

  if (!r2Object) {
    throw new Error(`Manifest not found in R2: ${record.cid}`);
  }

  const manifest = await r2Object.json();

  // 3. Extract version number (authoritative source)
  const ver = manifest.ver;
  if (typeof ver !== 'number') {
    throw new Error(`Manifest missing ver field: ${record.cid}`);
  }

  // 4. Prepare upload payload
  const payload = {
    attestation: {
      pi: record.entity_id,
      ver,
      cid: record.cid,
      op: record.op,
      vis: record.vis,
      prev_cid: record.prev_cid,
      ts: new Date(record.ts).getTime(),
    },
    manifest,
  };

  // 5. Upload to Arweave
  const wallet = JSON.parse(env.ARWEAVE_WALLET);
  const data = JSON.stringify(payload);

  const tx = await arweave.createTransaction({ data }, wallet);

  // Add tags for queryability
  tx.addTag('Content-Type', 'application/json');
  tx.addTag('App-Name', 'Arke');
  tx.addTag('Type', 'manifest');
  tx.addTag('PI', record.entity_id);
  tx.addTag('Ver', ver.toString());
  tx.addTag('CID', record.cid);
  tx.addTag('Op', record.op);
  tx.addTag('Vis', record.vis);

  if (record.prev_cid) {
    tx.addTag('Prev-CID', record.prev_cid);
  }

  await arweave.transactions.sign(tx, wallet);
  const response = await arweave.transactions.post(tx);

  if (response.status !== 200) {
    throw new Error(`Arweave upload failed: ${response.status} ${response.statusText}`);
  }

  console.log(`[ATTESTATION] Uploaded ${record.entity_id}:v${ver} → ${tx.id}`);

  // 6. Store TX ID in KV index
  const kvKey = `attest:${record.entity_id}:${ver}`;
  await env.ATTESTATION_INDEX.put(kvKey, JSON.stringify({
    cid: record.cid,
    tx: tx.id,
    ts: new Date(record.ts).getTime(),
  }));

  // 7. Delete from queue (success!)
  await db.prepare('DELETE FROM attestation_queue WHERE id = ?').bind(record.id).run();
}

// =============================================================================
// Retry Logic (PROD only)
// =============================================================================

async function retryFailedItems(env) {
  console.log('[ATTESTATION] Running retry job');

  const db = env.D1_PROD;

  // Reset failed items with retries remaining
  const result = await db.prepare(`
    UPDATE attestation_queue
    SET status = 'pending', updated_at = ?
    WHERE status = 'failed' AND retry_count < ?
  `).bind(new Date().toISOString(), MAX_RETRIES).run();

  console.log(`[ATTESTATION] Reset ${result.meta.changes} failed items`);

  // Log abandoned items
  const abandoned = await db.prepare(`
    SELECT entity_id, cid, error_message, retry_count FROM attestation_queue
    WHERE status = 'failed' AND retry_count >= ?
  `).bind(MAX_RETRIES).all();

  for (const item of abandoned.results) {
    console.error(`[ATTESTATION] Abandoned: ${item.entity_id}:${item.cid} (${item.retry_count} retries) - ${item.error_message}`);
  }
}

async function cleanupStuckItems(env) {
  console.log('[ATTESTATION] Cleaning up stuck items');

  const db = env.D1_PROD;

  // Reset items stuck in 'uploading' for > 10 minutes
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const result = await db.prepare(`
    UPDATE attestation_queue
    SET status = 'pending', updated_at = ?
    WHERE status = 'uploading' AND updated_at < ?
  `).bind(new Date().toISOString(), tenMinutesAgo).run();

  if (result.meta.changes > 0) {
    console.log(`[ATTESTATION] Reset ${result.meta.changes} stuck items`);
  }
}
```

### 3. Manifest Fetching Strategy

**Using direct R2 access (recommended)**
- Fastest option, no network hop
- Requires R2 bucket bindings
- Key format: just `{cid}` (content-addressed, no path prefix)
- Route to correct bucket based on entity_id prefix (II = test, otherwise prod)

```javascript
// Manifests are stored by CID directly
const r2Object = await r2.get(record.cid);
const manifest = await r2Object.json();
```

Alternative options (not recommended):
- Service binding to arke-v1: adds complexity
- HTTP fetch to arke-v1 API: adds latency

---

## Testing Plan

### 1. Local Testing
```bash
cd worker
npm run dev  # Start local worker

# In another terminal, trigger processing
curl -X POST http://localhost:8787/trigger
```

### 2. Verify Queue Processing
```bash
# Check queue before
wrangler d1 execute D1_PROD --remote --command "SELECT COUNT(*) FROM attestation_queue WHERE status='pending'"

# Wait for cron or trigger manually
curl -X POST https://arke-attestation.YOUR_SUBDOMAIN.workers.dev/trigger

# Check queue after
wrangler d1 execute D1_PROD --remote --command "SELECT * FROM attestation_queue LIMIT 5"
```

### 3. Verify KV Population
```bash
wrangler kv key list --namespace-id=8637de60b50f4572b1ba7f312479a4be --prefix="attest:"
```

### 4. Verify Arweave Upload
```bash
# Get TX ID from logs or KV
curl https://arweave.net/YOUR_TX_ID | jq .
```

---

## Deployment Steps

1. **Update wrangler.jsonc** with bindings and crons
2. **Rewrite src/index.js** with queue processor
3. **Test locally** with `npm run dev`
4. **Deploy**: `npm run deploy`
5. **Set secrets** if not already done:
   ```bash
   wrangler secret put ARWEAVE_WALLET
   # Paste wallet JSON
   ```
6. **Monitor logs**: `wrangler tail`
7. **Verify** queue is being processed

---

## Monitoring & Alerts

### Key Metrics to Watch
- Queue size (pending items)
- Failed item count
- Arweave upload success rate
- KV write success rate

### Log Messages
- `[ATTESTATION] Processing N items for network`
- `[ATTESTATION] Uploaded pi:vN → tx_id`
- `[ATTESTATION] Failed pi:cid: error`
- `[ATTESTATION] Abandoned: pi:cid`

### Potential Issues
1. **Arweave rate limiting**: Add exponential backoff
2. **Large manifests**: May need chunked upload
3. **Wallet balance**: Monitor AR balance
4. **D1 timeouts**: Reduce batch size if needed

---

## Cost Estimate

- **Arweave storage**: ~$6-8/GB (one-time)
- **Average manifest**: ~2KB
- **5K events/day**: ~10MB/day = ~$0.06-0.08/day
- **Monthly estimate**: ~$2-3/month

Worker costs (Cloudflare):
- Cron invocations: Free tier covers this
- D1 queries: Included in plan
- KV operations: Included in plan

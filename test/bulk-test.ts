/**
 * Bulk test - create many entities and monitor queue drain time
 */

import { ArkeClient } from "@arke-institute/sdk";

const API_KEY = process.env.ARKE_API_KEY;
if (!API_KEY) {
  console.error("ARKE_API_KEY required");
  process.exit(1);
}

const NETWORK = (process.env.ARKE_NETWORK || "main") as "main" | "test";
const ENTITY_COUNT = parseInt(process.env.ENTITY_COUNT || "20");

const arke = new ArkeClient({
  authToken: API_KEY,
  network: NETWORK,
});

const WORKER_URL = "https://arke-attestation.nick-chimicles-professional.workers.dev";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WorkerHealth {
  chain: { seq: number; head_tx: string | null };
  queue: { pending: number; processing: number; failed: number; total: number };
  config: { batch_size: number };
  last_batch: { processed: number; succeeded: number; failed: number; duration: number } | null;
}

async function getWorkerHealth(): Promise<WorkerHealth> {
  const res = await fetch(WORKER_URL);
  return res.json() as Promise<WorkerHealth>;
}

async function getOrCreateCollection() {
  const { data: collections } = await arke.api.GET("/collections");

  if (collections?.data && collections.data.length > 0) {
    return collections.data[0];
  }

  const { data: newCol, error } = await arke.api.POST("/collections", {
    body: {
      label: "Bulk Test Collection",
      description: "Collection for bulk attestation testing",
    },
  });

  if (error) throw new Error(`Failed to create collection: ${JSON.stringify(error)}`);
  return newCol!;
}

async function createEntities(collectionId: string, count: number) {
  console.log(`\n📝 Creating ${count} entities...\n`);

  const created: string[] = [];
  const startTime = Date.now();

  for (let i = 0; i < count; i++) {
    const { data: entity, error } = await arke.api.POST("/entities", {
      body: {
        collection_id: collectionId,
        type: "document",
        properties: {
          index: i + 1,
          batch: startTime,
          timestamp: new Date().toISOString(),
        },
      },
    });

    if (error) {
      console.error(`Failed to create entity ${i + 1}:`, error);
      continue;
    }

    created.push(entity.id);
    process.stdout.write(`\r   Created ${i + 1}/${count}`);
  }

  const duration = Date.now() - startTime;
  console.log(`\n\n✅ Created ${created.length} entities in ${(duration / 1000).toFixed(1)}s`);
  console.log(`   Rate: ${(created.length / (duration / 1000)).toFixed(1)} entities/sec\n`);

  return created;
}

async function monitorQueue(expectedCount: number) {
  console.log(`\n⏳ Monitoring queue (expecting ~${expectedCount} items to process)...\n`);

  const startTime = Date.now();
  const startHealth = await getWorkerHealth();
  const startSeq = startHealth.chain.seq;

  console.log(`   Start seq: ${startSeq}`);
  console.log(`   Start queue: pending=${startHealth.queue.pending}, processing=${startHealth.queue.processing}, total=${startHealth.queue.total}`);
  console.log(`   Batch size: ${startHealth.config.batch_size}\n`);

  let lastSeq = startSeq;
  let stableCount = 0;

  while (true) {
    await sleep(5000); // Check every 5 seconds

    const health = await getWorkerHealth();
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const processed = health.chain.seq - startSeq;
    const rate = processed > 0 ? (processed / elapsed).toFixed(2) : "0";

    console.log(
      `   [${elapsed}s] seq=${health.chain.seq} (+${processed}) | ` +
      `queue: ${health.queue.total} (pending=${health.queue.pending}, processing=${health.queue.processing}) | ` +
      `rate=${rate}/sec`
    );

    // Check if queue is drained
    if (health.queue.total === 0) {
      if (health.chain.seq === lastSeq) {
        stableCount++;
        if (stableCount >= 2) {
          // Queue stable for 10+ seconds
          break;
        }
      } else {
        stableCount = 0;
      }
    } else {
      stableCount = 0;
    }

    lastSeq = health.chain.seq;

    // Timeout after 10 minutes
    if (elapsed > 600) {
      console.log("\n⚠️ Timeout after 10 minutes");
      break;
    }
  }

  const endHealth = await getWorkerHealth();
  const totalDuration = (Date.now() - startTime) / 1000;
  const totalProcessed = endHealth.chain.seq - startSeq;

  console.log(`\n${"=".repeat(50)}`);
  console.log("RESULTS");
  console.log("=".repeat(50));
  console.log(`   Total time: ${totalDuration.toFixed(1)}s`);
  console.log(`   Items processed: ${totalProcessed}`);
  console.log(`   Average rate: ${(totalProcessed / totalDuration).toFixed(2)} items/sec`);
  console.log(`   Average time per item: ${(totalDuration / totalProcessed).toFixed(2)}s`);
  console.log(`   Final seq: ${endHealth.chain.seq}`);
  console.log(`   Final head: ${endHealth.chain.head_tx}`);
  console.log("=".repeat(50));
}

async function main() {
  console.log("=".repeat(50));
  console.log(`BULK ATTESTATION TEST (${ENTITY_COUNT} entities)`);
  console.log("=".repeat(50));

  // Get initial state
  const healthBefore = await getWorkerHealth();
  console.log(`\nInitial state:`);
  console.log(`   Chain seq: ${healthBefore.chain.seq}`);
  console.log(`   Queue: total=${healthBefore.queue.total} (pending=${healthBefore.queue.pending}, processing=${healthBefore.queue.processing})`);

  // Get or create collection
  const collection = await getOrCreateCollection();
  console.log(`\nUsing collection: ${collection.id}`);

  // Create entities
  const entities = await createEntities(collection.id, ENTITY_COUNT);

  // Check queue after creation
  await sleep(2000);
  const healthAfterCreate = await getWorkerHealth();
  console.log(`Queue after creation: total=${healthAfterCreate.queue.total} (pending=${healthAfterCreate.queue.pending})`);

  // Monitor until drained
  await monitorQueue(entities.length);
}

main().catch(console.error);

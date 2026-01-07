/**
 * Test script for the attestation chain workflow:
 * 1. Create an entity via Arke API
 * 2. Wait for attestation worker to process it
 * 3. Check attestation status
 * 4. Verify the attestation on Arweave
 */

import { ArkeClient } from "@arke-institute/sdk";

// Load API key from environment
const API_KEY = process.env.ARCHON_API_KEY || process.env.ARKE_API_KEY;

if (!API_KEY) {
  console.error("Error: ARCHON_API_KEY or ARKE_API_KEY environment variable required");
  console.error("Set it in .env file or export it in your shell");
  process.exit(1);
}

// Try test network first, can switch to main for attestation testing
const NETWORK = (process.env.ARKE_NETWORK || "test") as "main" | "test";

const arke = new ArkeClient({
  authToken: API_KEY,
  network: NETWORK,
});

console.log(`Using network: ${NETWORK}\n`);

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTestEntity() {
  console.log("📝 Creating test entity...\n");

  // First, we need a collection to create an entity in
  // Let's list collections to find one we can use
  const { data: collections, error: colError } = await arke.api.GET("/collections");

  let collection: { id: string; label: string };

  if (colError || !collections?.data || collections.data.length === 0) {
    console.log("No collections found. Creating one...\n");

    const { data: newCol, error: createColError } = await arke.api.POST("/collections", {
      body: {
        label: "Attestation Test Collection",
        description: "Collection for attestation chain testing",
      },
    });

    if (createColError || !newCol) {
      console.error("Failed to create collection:", createColError);
      return null;
    }

    collection = newCol;
    console.log(`✅ Created collection: ${collection.label} (${collection.id})\n`);
  } else {
    // Use the first collection
    collection = collections.data[0];
    console.log(`Using existing collection: ${collection.label} (${collection.id})\n`);
  }

  // Create a test entity
  const testData = {
    type: "document",
    label: `Attestation Test ${Date.now()}`,
    properties: {
      description: "Test entity for attestation chain verification",
      timestamp: new Date().toISOString(),
      random: Math.random().toString(36).substring(7),
    },
  };

  const { data: entity, error: createError } = await arke.api.POST("/entities", {
    body: {
      collection_id: collection.id,
      ...testData,
    },
  });

  if (createError) {
    console.error("Failed to create entity:", createError);
    return null;
  }

  console.log("✅ Entity created:");
  console.log(`   ID: ${entity.id}`);
  console.log(`   Label: ${entity.label}`);
  console.log(`   CID: ${entity.cid}`);
  console.log(`   Version: ${entity.ver}\n`);

  return entity;
}

async function checkAttestation(entityId: string) {
  console.log(`🔍 Checking attestation for entity ${entityId}...\n`);

  const { data, error, response } = await arke.api.GET("/entities/{id}/attestation", {
    params: { path: { id: entityId } },
  });

  if (response.status === 202) {
    console.log("⏳ Attestation pending - worker hasn't processed it yet");
    return { status: "pending", data };
  }

  if (response.status === 404) {
    console.log("❌ No attestation found");
    return { status: "not_found", data: null };
  }

  if (error) {
    console.error("Error checking attestation:", error);
    return { status: "error", data: null };
  }

  console.log("✅ Attestation found:");
  console.log(`   TX ID: ${data.tx}`);
  console.log(`   CID: ${data.cid}`);
  console.log(`   Seq: ${data.seq}`);
  console.log(`   URL: ${data.url}\n`);

  return { status: "found", data };
}

async function verifyAttestation(txId: string) {
  console.log(`🔐 Verifying attestation ${txId} on Arweave...\n`);

  const { data, error } = await arke.api.GET("/attestations/verify/{tx}", {
    params: { path: { tx: txId } },
  });

  if (error) {
    console.error("Verification failed:", error);
    return null;
  }

  console.log("✅ Verification result:");
  console.log(`   Valid: ${data.attestation}`);
  console.log(`   PI: ${data.pi}`);
  console.log(`   Version: ${data.ver}`);
  console.log(`   Seq: ${data.seq}`);

  if (data.prev_tx) {
    console.log(`   Prev TX: ${data.prev_tx}`);
  }

  console.log("");

  return data;
}

async function waitForAttestation(entityId: string, maxWaitMs = 180000) {
  const startTime = Date.now();
  const pollInterval = 5000; // 5 seconds

  console.log(`⏳ Waiting for attestation (max ${maxWaitMs / 1000}s)...\n`);

  while (Date.now() - startTime < maxWaitMs) {
    const result = await checkAttestation(entityId);

    if (result.status === "found") {
      return result.data;
    }

    if (result.status === "error") {
      console.log("Error occurred, will retry...");
    }

    console.log(`   Still waiting... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
    await sleep(pollInterval);
  }

  console.log("❌ Timeout waiting for attestation\n");
  return null;
}

async function checkWorkerHealth() {
  console.log("🏥 Checking attestation worker health...\n");

  try {
    const response = await fetch(
      "https://arke-attestation.nick-chimicles-professional.workers.dev/"
    );
    const health = await response.json();

    console.log("Worker status:");
    console.log(`   Service: ${health.service}`);
    console.log(`   Version: ${health.version}`);
    console.log(`   Chain Seq: ${health.chain.seq}`);
    console.log(`   Chain Head: ${health.chain.head_tx || "(genesis)"}`);
    console.log(`   Queue: pending=${health.queue.pending}, uploading=${health.queue.uploading}, failed=${health.queue.failed}`);
    console.log("");

    return health;
  } catch (e) {
    console.error("Failed to check worker health:", e);
    return null;
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("ARKE ATTESTATION CHAIN TEST");
  console.log("=".repeat(60));
  console.log("");

  // 1. Check worker health
  const healthBefore = await checkWorkerHealth();

  // 2. Create test entity
  const entity = await createTestEntity();
  if (!entity) {
    process.exit(1);
  }

  // 3. Wait for attestation
  const attestation = await waitForAttestation(entity.id);

  // 4. Check worker health again
  const healthAfter = await checkWorkerHealth();

  if (healthBefore && healthAfter) {
    console.log(`📈 Chain grew from seq ${healthBefore.chain.seq} to ${healthAfter.chain.seq}`);
    console.log("");
  }

  // 5. Verify attestation on Arweave
  if (attestation?.tx) {
    await verifyAttestation(attestation.tx);
  }

  console.log("=".repeat(60));
  console.log("TEST COMPLETE");
  console.log("=".repeat(60));
}

main().catch(console.error);

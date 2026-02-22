/**
 * Step 4: Verify Re-Attestation
 *
 * Checks that re-attested items are now accessible via Turbo.
 *
 * Run with: npx tsx scripts/re-attestation/04-verify-reattestation.ts
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GRAPHQL_URL = "https://arweave.net/graphql";
const OWNER = "nYzifs8Of9xr011iJ2NklkOFWfiRNl4gJ4YV9reqbA0";
const LAST_GOOD_SEQ = 296736;

interface VerifyResult {
  entityId: string;
  oldSeq: number;
  newSeq?: number;
  newTxId?: string;
  dataAccessible: boolean;
  status: "ok" | "pending" | "failed";
}

async function getLatestAttestation(
  entityId: string
): Promise<{ seq: number; txId: string } | null> {
  const query = `
    query {
      transactions(
        owners: ["${OWNER}"]
        tags: [
          { name: "App-Name", values: ["Arke"] }
          { name: "Type", values: ["attestation"] }
          { name: "PI", values: ["${entityId}"] }
        ]
        first: 1
        sort: HEIGHT_DESC
      ) {
        edges {
          node {
            id
            tags { name value }
          }
        }
      }
    }
  `;

  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) return null;

  const data = await response.json();
  const edge = data.data?.transactions?.edges?.[0];

  if (!edge) return null;

  const seqTag = edge.node.tags.find((t: any) => t.name === "Seq");
  return {
    seq: seqTag ? parseInt(seqTag.value, 10) : 0,
    txId: edge.node.id,
  };
}

async function checkDataAccessible(txId: string): Promise<boolean> {
  try {
    const response = await fetch(`https://arweave.net/${txId}`, {
      method: "GET",
    });

    if (!response.ok) return false;

    const text = await response.text();
    return text.includes("attestation");
  } catch {
    return false;
  }
}

async function main() {
  const sampleSize = parseInt(process.argv[2] || "10", 10);

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              VERIFY RE-ATTESTATION                            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Load affected entities
  const inputPath = path.join(__dirname, "affected-entities.json");
  if (!fs.existsSync(inputPath)) {
    console.error("Error: affected-entities.json not found");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  console.log(`Loaded ${data.entities.length} affected entities\n`);

  // Sample entities to verify
  const sample = data.details
    .sort(() => Math.random() - 0.5)
    .slice(0, sampleSize) as Array<{
    entityId: string;
    seq: number;
  }>;

  console.log(`Verifying ${sample.length} random entities...\n`);

  const results: VerifyResult[] = [];

  for (const entity of sample) {
    process.stdout.write(`   Checking ${entity.entityId}...`);

    const latest = await getLatestAttestation(entity.entityId);

    if (!latest) {
      results.push({
        entityId: entity.entityId,
        oldSeq: entity.seq,
        dataAccessible: false,
        status: "pending",
      });
      console.log(" NOT FOUND (pending?)");
      continue;
    }

    const dataOk = await checkDataAccessible(latest.txId);

    const status: "ok" | "pending" | "failed" =
      latest.seq > LAST_GOOD_SEQ && dataOk
        ? "ok"
        : latest.seq > entity.seq
          ? "pending"
          : "failed";

    results.push({
      entityId: entity.entityId,
      oldSeq: entity.seq,
      newSeq: latest.seq,
      newTxId: latest.txId,
      dataAccessible: dataOk,
      status,
    });

    const statusIcon = status === "ok" ? "✓" : status === "pending" ? "⏳" : "✗";
    console.log(
      ` ${statusIcon} seq ${entity.seq} -> ${latest.seq}, data: ${dataOk ? "OK" : "FAIL"}`
    );

    // Rate limiting
    await new Promise((r) => setTimeout(r, 200));
  }

  // Summary
  const ok = results.filter((r) => r.status === "ok").length;
  const pending = results.filter((r) => r.status === "pending").length;
  const failed = results.filter((r) => r.status === "failed").length;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("VERIFICATION RESULTS");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`   ✓ OK:      ${ok}/${sample.length} (${((ok / sample.length) * 100).toFixed(1)}%)`);
  console.log(`   ⏳ Pending: ${pending}/${sample.length}`);
  console.log(`   ✗ Failed:  ${failed}/${sample.length}`);
  console.log("═══════════════════════════════════════════════════════════════");

  if (failed > 0) {
    console.log("\nFailed entities:");
    results
      .filter((r) => r.status === "failed")
      .forEach((r) => {
        console.log(`   ${r.entityId}: seq ${r.oldSeq} -> ${r.newSeq || "?"}`);
      });
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

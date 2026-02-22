/**
 * Step 3: Re-queue Entities for Attestation
 *
 * For each affected entity:
 * 1. Fetch current manifest CID from arke-v1 API
 * 2. Generate SQL INSERT statements
 * 3. Execute via wrangler d1
 *
 * Run with: npx tsx scripts/re-attestation/03-requeue-entities.ts
 *
 * Prerequisites:
 * - Run 02-extract-affected-entities.ts first
 * - Have wrangler configured
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARKE_API_URL = "https://arke-v1.arke.institute";
const D1_DATABASE = "arke-prod";
const BATCH_SIZE = 50; // SQL statements per batch

interface AffectedEntitiesFile {
  extractedAt: string;
  lastGoodSeq: number;
  totalAffected: number;
  entities: string[];
  details: Array<{
    entityId: string;
    seq: number;
    cid: string;
    txId: string;
  }>;
}

interface EntityInfo {
  entityId: string;
  cid: string;
  vis: string;
}

interface ArkeEntityResponse {
  id: string;
  type: string;
  cid?: string;
  visibility?: string;
  [key: string]: unknown;
}

async function fetchEntityInfo(entityId: string): Promise<EntityInfo | null> {
  try {
    const response = await fetch(`${ARKE_API_URL}/entities/${entityId}`, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null; // Entity deleted or doesn't exist
      }
      throw new Error(`API error: ${response.status}`);
    }

    const data = (await response.json()) as ArkeEntityResponse;

    return {
      entityId: data.id,
      cid: data.cid || "",
      vis: data.visibility === "private" ? "priv" : "pub",
    };
  } catch (error) {
    console.error(`   Failed to fetch ${entityId}: ${error}`);
    return null;
  }
}

function generateInsertSQL(entities: EntityInfo[]): string {
  const now = new Date().toISOString();
  const values = entities
    .map(
      (e) =>
        `('${e.entityId}', '${e.cid}', 'U', '${e.vis}', '${now}', 'pending', '${now}', '${now}', 0, NULL)`
    )
    .join(",\n  ");

  return `INSERT INTO attestation_queue (entity_id, cid, op, vis, ts, status, created_at, updated_at, retry_count, error_message)
VALUES
  ${values}
ON CONFLICT (entity_id, cid) DO NOTHING;`;
}

async function executeSQL(sql: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log("   [DRY RUN] Would execute SQL:");
    console.log("   " + sql.split("\n").slice(0, 3).join("\n   ") + "...");
    return;
  }

  // Write SQL to temp file
  const tempFile = path.join(__dirname, ".temp-sql.txt");
  fs.writeFileSync(tempFile, sql);

  try {
    execSync(`wrangler d1 execute ${D1_DATABASE} --remote --file="${tempFile}"`, {
      cwd: path.join(__dirname, "../.."),
      stdio: "pipe",
    });
  } finally {
    fs.unlinkSync(tempFile);
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const skipFetch = process.argv.includes("--skip-fetch");

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              RE-QUEUE ENTITIES FOR ATTESTATION                ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  if (dryRun) {
    console.log("🔍 DRY RUN MODE - No changes will be made\n");
  }

  // Load affected entities
  const inputPath = path.join(__dirname, "affected-entities.json");
  if (!fs.existsSync(inputPath)) {
    console.error("Error: affected-entities.json not found");
    console.error("Run 02-extract-affected-entities.ts first");
    process.exit(1);
  }

  const data: AffectedEntitiesFile = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  console.log(`Loaded ${data.entities.length} affected entities\n`);

  // Fetch current entity info from API
  console.log("1. Fetching current entity info from arke-v1 API...\n");

  const entitiesToQueue: EntityInfo[] = [];
  const notFound: string[] = [];
  const errors: string[] = [];

  let processed = 0;
  for (const entityId of data.entities) {
    processed++;

    if (skipFetch) {
      // Use the CID from the broken attestation (may be outdated)
      const detail = data.details.find((d) => d.entityId === entityId);
      if (detail) {
        entitiesToQueue.push({
          entityId,
          cid: detail.cid,
          vis: "pub", // Default to public
        });
      }
    } else {
      const info = await fetchEntityInfo(entityId);

      if (info) {
        if (info.cid) {
          entitiesToQueue.push(info);
        } else {
          notFound.push(entityId);
        }
      } else {
        notFound.push(entityId);
      }

      // Progress
      if (processed % 100 === 0 || processed === data.entities.length) {
        process.stdout.write(
          `\r   Progress: ${processed}/${data.entities.length} (${entitiesToQueue.length} valid, ${notFound.length} not found)`
        );
      }

      // Rate limiting
      if (processed % 10 === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  console.log("\n");

  console.log(`\n2. Summary:`);
  console.log(`   Entities to re-queue: ${entitiesToQueue.length}`);
  console.log(`   Not found (deleted?): ${notFound.length}`);

  if (entitiesToQueue.length === 0) {
    console.log("\n   No entities to queue. Done.");
    return;
  }

  // Write entities to queue file for reference
  const queueFile = path.join(__dirname, "entities-to-queue.json");
  fs.writeFileSync(queueFile, JSON.stringify(entitiesToQueue, null, 2));
  console.log(`   Queue list saved to: entities-to-queue.json`);

  // Generate and execute SQL in batches
  console.log(`\n3. Inserting into attestation_queue (${BATCH_SIZE} per batch)...`);

  let totalInserted = 0;
  for (let i = 0; i < entitiesToQueue.length; i += BATCH_SIZE) {
    const batch = entitiesToQueue.slice(i, i + BATCH_SIZE);
    const sql = generateInsertSQL(batch);

    try {
      await executeSQL(sql, dryRun);
      totalInserted += batch.length;

      if (!dryRun) {
        process.stdout.write(`\r   Inserted: ${totalInserted}/${entitiesToQueue.length}`);
      }
    } catch (error) {
      console.error(`\n   Error inserting batch at ${i}: ${error}`);
      errors.push(`Batch ${i}: ${error}`);
    }
  }

  console.log("\n");

  if (errors.length > 0) {
    console.log(`\n   Errors encountered: ${errors.length}`);
    errors.slice(0, 5).forEach((e) => console.log(`   - ${e}`));
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("DONE");
  if (!dryRun) {
    console.log(`\nInserted ${totalInserted} entities into attestation_queue`);
    console.log("The cron job will process them via Turbo uploads.");
  }
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

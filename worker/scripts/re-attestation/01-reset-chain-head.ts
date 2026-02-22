/**
 * Step 1: Reset Chain Head
 *
 * Resets the attestation chain head to the last known good attestation (seq 296736).
 * This allows new attestations to link from this point, orphaning the broken segment.
 *
 * Run with: npx tsx scripts/re-attestation/01-reset-chain-head.ts
 *
 * NOTE: This modifies production KV. Run with --dry-run first to preview.
 */

import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerDir = path.join(__dirname, "../..");

const LAST_GOOD_HEAD = {
  tx_id: "_GYhIYUtqi7fbjs49VMHCb6JEhi3UDtm9-IjeSnWkAY",
  cid: "bafkreidfm55ombtowirob3icp4nwqp3qs3dsosptl7halpiiyu2kyipisq",
  seq: 296736,
};

const KV_NAMESPACE_ID = "8637de60b50f4572b1ba7f312479a4be"; // ATTESTATION_INDEX
const D1_DATABASE = "arke-prod";

function runWrangler(command: string): string {
  try {
    return execSync(`wrangler ${command}`, {
      cwd: workerDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error: any) {
    throw new Error(`Wrangler command failed: ${error.stderr || error.message}`);
  }
}

function getCurrentHead(): { tx_id: string; cid: string; seq: number } | null {
  try {
    // Read from D1 (source of truth)
    const output = runWrangler(
      `d1 execute ${D1_DATABASE} --remote --command "SELECT tx_id, cid, seq FROM chain_state WHERE key = 'head';"`
    );
    const match = output.match(/"tx_id":\s*"([^"]+)".*?"cid":\s*"([^"]+)".*?"seq":\s*(\d+)/s);
    if (match) {
      return {
        tx_id: match[1],
        cid: match[2],
        seq: parseInt(match[3], 10),
      };
    }
    return null;
  } catch (error: any) {
    if (error.message.includes("no rows")) {
      return null;
    }
    throw error;
  }
}

function setChainHead(head: typeof LAST_GOOD_HEAD): void {
  const now = new Date().toISOString();

  // Update D1 (source of truth)
  runWrangler(
    `d1 execute ${D1_DATABASE} --remote --command "INSERT INTO chain_state (key, tx_id, cid, seq, updated_at) VALUES ('head', '${head.tx_id}', '${head.cid}', ${head.seq}, '${now}') ON CONFLICT(key) DO UPDATE SET tx_id = excluded.tx_id, cid = excluded.cid, seq = excluded.seq, updated_at = excluded.updated_at;"`
  );

  // Also update KV for API access
  const kvValue = JSON.stringify({ tx: head.tx_id, cid: head.cid, seq: head.seq, updated_at: now });
  runWrangler(
    `kv key put --namespace-id=${KV_NAMESPACE_ID} "chain:head" '${kvValue}'`
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              RESET CHAIN HEAD                                 ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  if (dryRun) {
    console.log("🔍 DRY RUN MODE - No changes will be made\n");
  }

  // Get current head
  console.log("1. Fetching current chain head...");
  const currentHead = getCurrentHead();

  if (currentHead) {
    console.log(`   Current head:`);
    console.log(`   - TX:  ${currentHead.tx_id}`);
    console.log(`   - CID: ${currentHead.cid}`);
    console.log(`   - Seq: ${currentHead.seq}`);
  } else {
    console.log("   No current head found");
  }

  console.log(`\n2. Target head (last good):`);
  console.log(`   - TX:  ${LAST_GOOD_HEAD.tx_id}`);
  console.log(`   - CID: ${LAST_GOOD_HEAD.cid}`);
  console.log(`   - Seq: ${LAST_GOOD_HEAD.seq}`);

  if (currentHead) {
    const seqDiff = currentHead.seq - LAST_GOOD_HEAD.seq;
    console.log(`\n   Rolling back ${seqDiff} sequences`);
  }

  if (dryRun) {
    console.log("\n3. [DRY RUN] Would update chain head to:");
    console.log(`   ${JSON.stringify(LAST_GOOD_HEAD)}`);
    console.log("\n   Run without --dry-run to apply changes");
  } else {
    console.log("\n3. Updating chain head...");
    setChainHead(LAST_GOOD_HEAD);
    console.log("   ✓ Chain head updated");

    // Verify
    console.log("\n4. Verifying...");
    const newHead = getCurrentHead();
    if (newHead && newHead.seq === LAST_GOOD_HEAD.seq) {
      console.log("   ✓ Verified - chain head is now at seq", newHead.seq);
    } else {
      console.error("   ✗ Verification failed!");
      console.error("   Got:", newHead);
      process.exit(1);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("DONE");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

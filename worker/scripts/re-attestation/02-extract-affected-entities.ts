/**
 * Step 2: Extract Affected Entities
 *
 * Queries GraphQL to find all attestations with seq > 296736 (broken range)
 * and extracts unique entity IDs for re-attestation.
 *
 * Run with: npx tsx scripts/re-attestation/02-extract-affected-entities.ts
 *
 * Outputs: affected-entities.json with list of entity IDs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LAST_GOOD_SEQ = 296736;
const GRAPHQL_URL = "https://arweave.net/graphql";
const OWNER = "nYzifs8Of9xr011iJ2NklkOFWfiRNl4gJ4YV9reqbA0";

interface GraphQLResponse {
  data: {
    transactions: {
      edges: Array<{
        node: {
          id: string;
          tags: Array<{ name: string; value: string }>;
        };
        cursor: string;
      }>;
      pageInfo: {
        hasNextPage: boolean;
      };
    };
  };
}

async function queryGraphQL(cursor?: string): Promise<GraphQLResponse> {
  const afterClause = cursor ? `, after: "${cursor}"` : "";

  const query = `
    query {
      transactions(
        owners: ["${OWNER}"]
        tags: [
          { name: "App-Name", values: ["Arke"] }
          { name: "Type", values: ["attestation"] }
        ]
        first: 100
        ${afterClause}
      ) {
        edges {
          node {
            id
            tags { name value }
          }
          cursor
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL error: ${response.status}`);
  }

  return response.json() as Promise<GraphQLResponse>;
}

function getTagValue(tags: Array<{ name: string; value: string }>, name: string): string | null {
  const tag = tags.find((t) => t.name === name);
  return tag ? tag.value : null;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              EXTRACT AFFECTED ENTITIES                        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  console.log(`Finding attestations with seq > ${LAST_GOOD_SEQ}...\n`);

  const affectedEntities = new Map<string, { seq: number; cid: string; txId: string }>();
  let cursor: string | undefined;
  let totalProcessed = 0;
  let pagesProcessed = 0;
  let foundInBrokenRange = 0;

  // Track the highest seq we've seen to know when we've gone past the broken range
  let lowestSeqSeen = Infinity;
  let reachedGoodRange = false;

  while (!reachedGoodRange) {
    const result = await queryGraphQL(cursor);
    const edges = result.data.transactions.edges;
    pagesProcessed++;

    if (edges.length === 0) break;

    for (const edge of edges) {
      const tags = edge.node.tags;
      const seqStr = getTagValue(tags, "Seq");
      const entityId = getTagValue(tags, "PI");
      const cid = getTagValue(tags, "CID");

      if (!seqStr || !entityId || !cid) continue;

      const seq = parseInt(seqStr, 10);
      totalProcessed++;

      if (seq < lowestSeqSeen) {
        lowestSeqSeen = seq;
      }

      // Check if we've reached attestations before the broken range
      if (seq <= LAST_GOOD_SEQ) {
        reachedGoodRange = true;
        continue;
      }

      foundInBrokenRange++;

      // Track the entity with its highest broken seq
      const existing = affectedEntities.get(entityId);
      if (!existing || seq > existing.seq) {
        affectedEntities.set(entityId, {
          seq,
          cid,
          txId: edge.node.id,
        });
      }
    }

    // Progress update
    process.stdout.write(
      `\r   Pages: ${pagesProcessed}, Processed: ${totalProcessed}, In broken range: ${foundInBrokenRange}, Unique entities: ${affectedEntities.size}`
    );

    if (!result.data.transactions.pageInfo.hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("\n");

  // Convert to array and sort by seq
  const entities = Array.from(affectedEntities.entries())
    .map(([entityId, data]) => ({
      entityId,
      ...data,
    }))
    .sort((a, b) => a.seq - b.seq);

  console.log(`\nResults:`);
  console.log(`   Total attestations processed: ${totalProcessed}`);
  console.log(`   Attestations in broken range: ${foundInBrokenRange}`);
  console.log(`   Unique entities affected: ${entities.length}`);
  console.log(`   Lowest seq seen: ${lowestSeqSeen}`);

  // Sample of affected entities
  console.log(`\nSample affected entities (first 5):`);
  entities.slice(0, 5).forEach((e) => {
    console.log(`   ${e.entityId} (seq ${e.seq})`);
  });

  // Write to file
  const outputPath = path.join(__dirname, "affected-entities.json");
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        extractedAt: new Date().toISOString(),
        lastGoodSeq: LAST_GOOD_SEQ,
        totalAffected: entities.length,
        entities: entities.map((e) => e.entityId),
        // Also include full details for reference
        details: entities,
      },
      null,
      2
    )
  );

  console.log(`\nOutput written to: ${outputPath}`);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("DONE");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

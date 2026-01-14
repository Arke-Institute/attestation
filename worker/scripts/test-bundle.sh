#!/bin/bash
#
# Bundle Test Script
#
# Tests the ANS-104 bundling implementation by:
# 1. Uploading a bundle of test items to Arweave
# 2. Verifying each DataItem is accessible
#
# Usage: ./scripts/test-bundle.sh [count] [worker_url]
#   count: Number of items to bundle (default: 10)
#   worker_url: Worker URL (default: http://localhost:8787)
#

set -e

COUNT=${1:-10}
WORKER_URL=${2:-http://localhost:8787}

echo "================================================"
echo "  Arke Bundle Test"
echo "================================================"
echo ""
echo "Items to bundle: $COUNT"
echo "Worker URL: $WORKER_URL"
echo ""

# Run the test
echo "Uploading bundle to Arweave..."
echo ""

RESULT=$(curl -s -X POST "${WORKER_URL}/test-bundle?count=${COUNT}")

# Check for success
SUCCESS=$(echo "$RESULT" | jq -r '.success')

if [ "$SUCCESS" != "true" ]; then
  echo "Bundle test FAILED!"
  echo ""
  echo "Error: $(echo "$RESULT" | jq -r '.error')"
  echo ""
  echo "Full result:"
  echo "$RESULT" | jq .
  exit 1
fi

# Extract results
BUNDLE_TX=$(echo "$RESULT" | jq -r '.bundleTxId')
BUNDLE_SIZE=$(echo "$RESULT" | jq -r '.bundleSize')
ITEM_COUNT=$(echo "$RESULT" | jq -r '.itemCount')
SIGN_MS=$(echo "$RESULT" | jq -r '.timing.signMs')
UPLOAD_MS=$(echo "$RESULT" | jq -r '.timing.uploadMs')
TOTAL_MS=$(echo "$RESULT" | jq -r '.timing.totalMs')
SEQ_BEFORE=$(echo "$RESULT" | jq -r '.chainHead.before.seq')
SEQ_AFTER=$(echo "$RESULT" | jq -r '.chainHead.after.seq')

echo "Bundle uploaded successfully!"
echo ""
echo "================================================"
echo "  Results"
echo "================================================"
echo ""
echo "Bundle TX ID:  $BUNDLE_TX"
echo "Bundle Size:   $BUNDLE_SIZE bytes ($(echo "scale=2; $BUNDLE_SIZE / 1024" | bc) KB)"
echo "Items:         $ITEM_COUNT"
echo ""
echo "Timing:"
echo "  Sign:        ${SIGN_MS}ms"
echo "  Upload:      ${UPLOAD_MS}ms"
echo "  Total:       ${TOTAL_MS}ms"
echo ""
echo "Test Chain Head:"
echo "  Before:      seq=$SEQ_BEFORE"
echo "  After:       seq=$SEQ_AFTER"
echo ""

# List DataItem IDs
echo "================================================"
echo "  DataItem IDs"
echo "================================================"
echo ""
echo "$RESULT" | jq -r '.dataItemIds[]' | while read ID; do
  echo "  $ID"
done
echo ""

# Verify on Arweave (with delay to allow indexing)
echo "================================================"
echo "  Arweave Verification"
echo "================================================"
echo ""
echo "Note: DataItems may take a few seconds to be indexed by gateways."
echo "Waiting 5 seconds before verification..."
sleep 5
echo ""

# Get array of DataItem IDs
DATA_ITEM_IDS=$(echo "$RESULT" | jq -r '.dataItemIds[]')
VERIFIED=0
FAILED=0

for ID in $DATA_ITEM_IDS; do
  URL="https://arweave.net/$ID"

  # Check if accessible (follow redirects with -L)
  HTTP_CODE=$(curl -sL -o /dev/null -w "%{http_code}" --max-time 10 "$URL")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "  ✓ $ID (HTTP $HTTP_CODE)"
    VERIFIED=$((VERIFIED + 1))
  elif [ "$HTTP_CODE" = "202" ] || [ "$HTTP_CODE" = "302" ]; then
    echo "  ⏳ $ID (HTTP $HTTP_CODE - pending/redirect)"
    VERIFIED=$((VERIFIED + 1))
  else
    echo "  ✗ $ID (HTTP $HTTP_CODE)"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "================================================"
echo "  Summary"
echo "================================================"
echo ""
echo "Verified: $VERIFIED / $ITEM_COUNT"

if [ $FAILED -gt 0 ]; then
  echo "Failed:   $FAILED"
  echo ""
  echo "Some items may not be indexed yet. Try again in a few minutes."
fi

echo ""
echo "Bundle URL: https://arweave.net/$BUNDLE_TX"
echo ""

# Output for programmatic use
echo "Full JSON result saved to: /tmp/bundle-test-result.json"
echo "$RESULT" | jq . > /tmp/bundle-test-result.json

#!/usr/bin/env bash
# Test webhook handler against local wrangler dev.
#
# Usage:
#   ./scripts/test-webhook.sh                    # default: localhost:8787
#   ./scripts/test-webhook.sh https://my-worker.workers.dev  # deployed worker
#
# Requires: jq, openssl, curl
# Reads GITHUB_WEBHOOK_SECRET from .dev.vars automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BASE_URL="${1:-http://localhost:8787}"
PAYLOAD_FILE="$SCRIPT_DIR/fixtures/webhook-pr-opened.json"

# --- Read webhook secret from .dev.vars ---
DEV_VARS="$PROJECT_DIR/.dev.vars"
if [[ ! -f "$DEV_VARS" ]]; then
  echo "ERROR: .dev.vars not found at $DEV_VARS"
  exit 1
fi

WEBHOOK_SECRET=$(grep '^GITHUB_WEBHOOK_SECRET' "$DEV_VARS" | cut -d'=' -f2- | tr -d '"' | tr -d "'" | xargs)
if [[ -z "$WEBHOOK_SECRET" ]]; then
  echo "ERROR: GITHUB_WEBHOOK_SECRET not found in .dev.vars"
  exit 1
fi

# --- Read payload ---
if [[ ! -f "$PAYLOAD_FILE" ]]; then
  echo "ERROR: Payload fixture not found at $PAYLOAD_FILE"
  exit 1
fi

BODY=$(cat "$PAYLOAD_FILE")

# --- Compute HMAC-SHA256 signature ---
SIGNATURE=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')

echo "=== Test: Webhook PR Opened ==="
echo "URL:       $BASE_URL/webhook"
echo "Signature: sha256=$SIGNATURE"
echo ""

# --- Send request ---
HTTP_CODE=$(curl -s -o /tmp/webhook-response.json -w "%{http_code}" \
  -X POST "$BASE_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: test-$(date +%s)" \
  -H "X-Hub-Signature-256: sha256=$SIGNATURE" \
  -H "User-Agent: GitHub-Hookshot/test" \
  -d "$BODY")

RESPONSE=$(cat /tmp/webhook-response.json)

echo "Status:    $HTTP_CODE"
echo "Response:  $RESPONSE"
echo ""

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "PASS: Webhook accepted"
else
  echo "FAIL: Expected 200, got $HTTP_CODE"
  exit 1
fi

echo ""
echo "=== Test: Missing Signature ==="
HTTP_CODE=$(curl -s -o /tmp/webhook-response.json -w "%{http_code}" \
  -X POST "$BASE_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -d "$BODY")
RESPONSE=$(cat /tmp/webhook-response.json)
echo "Status:    $HTTP_CODE"
echo "Response:  $RESPONSE"
if [[ "$HTTP_CODE" == "401" ]]; then
  echo "PASS: Rejected without signature"
else
  echo "FAIL: Expected 401, got $HTTP_CODE"
  exit 1
fi

echo ""
echo "=== Test: Invalid Signature ==="
HTTP_CODE=$(curl -s -o /tmp/webhook-response.json -w "%{http_code}" \
  -X POST "$BASE_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000" \
  -d "$BODY")
RESPONSE=$(cat /tmp/webhook-response.json)
echo "Status:    $HTTP_CODE"
echo "Response:  $RESPONSE"
if [[ "$HTTP_CODE" == "401" ]]; then
  echo "PASS: Rejected with bad signature"
else
  echo "FAIL: Expected 401, got $HTTP_CODE"
  exit 1
fi

echo ""
echo "=== Test: Non-PR Event ==="
HTTP_CODE=$(curl -s -o /tmp/webhook-response.json -w "%{http_code}" \
  -X POST "$BASE_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: sha256=$SIGNATURE" \
  -H "User-Agent: GitHub-Hookshot/test" \
  -d "$BODY")
RESPONSE=$(cat /tmp/webhook-response.json)
echo "Status:    $HTTP_CODE"
echo "Response:  $RESPONSE"
if [[ "$HTTP_CODE" == "200" ]]; then
  echo "PASS: Ignored non-PR event"
else
  echo "FAIL: Expected 200, got $HTTP_CODE"
  exit 1
fi

echo ""
echo "=== All tests passed ==="

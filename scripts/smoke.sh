#!/bin/bash
# Smoke test: boots the server (throwaway registries) and runs the
# marketplace flow — keyless browsing + keyed booking.
# Usage: npm run smoke   (uses PORT 3457)
set -euo pipefail
cd "$(dirname "$0")/.."
export PORT="${PORT:-3457}"
export LUMEN_REGISTRY="$(mktemp -t lumen-smoke-keys-XXXXXX.json)"
export LUMEN_CUSTOMERS="$(mktemp -t lumen-smoke-profiles-XXXXXX.json)"
export LUMEN_PROVIDERS="data/providers.json"

# Seed a throwaway profile + key (printed key captured, hash stored in temp file).
SMOKE_PROFILE="$(mktemp -t lumen-smoke-signup-XXXXXX.json)"
LUMEN_REGISTRY="$LUMEN_REGISTRY" LUMEN_CUSTOMERS="$LUMEN_CUSTOMERS" \
  npx -y tsx src/customers-cli.ts create \
    --name "Smoke Test" --phone "+14165550000" --email "smoke@example.com" \
  > "$SMOKE_PROFILE" 2>/dev/null
SMOKE_KEY="$(tail -1 "$SMOKE_PROFILE")"
export LUMEN_KEY="$SMOKE_KEY"
rm -f "$SMOKE_PROFILE"

npx tsx src/index.ts > /tmp/lumen-smoke.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -f "$LUMEN_REGISTRY" "$LUMEN_CUSTOMERS"' EXIT
sleep 4

echo "--- keyless browsing must succeed (public) ---"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:${PORT}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
echo "no-auth tools/list status: $CODE"
[ "$CODE" = "200" ] || { echo "FAIL expected 200"; exit 1; }

echo "--- keyless booking must 401 (gated) ---"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:${PORT}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"book_appointment","arguments":{"provider_id":"lumen-hair-studio","quote_id":"x"}}}')"
echo "no-auth book status: $CODE"
[ "$CODE" = "401" ] || { echo "FAIL expected 401"; exit 1; }

node scripts/smoke.mjs

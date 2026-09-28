# Harness notes (private-test equivalent)

How automated harnesses and reviewers should call this connector.

## Transport

- Stateless streamable HTTP on `POST /mcp`. JSON-RPC 2.0 bodies.
- Always send `Accept: application/json, text/event-stream` (responses arrive
  as SSE `data:` frames). `GET /health` is public. `PORT` env is honored.

## Auth matrix

| Tool | Key? |
|---|---|
| `list_providers` | **no key** — send no `Authorization` header |
| `list_services` | **no key** |
| `check_availability` | **no key** |
| `create_quote` | **key required**: `Authorization: Bearer <key>` |
| `book_appointment` | **key required** |
| `reschedule_appointment` | **key required** |
| `cancel_appointment` | **key required** |

- The MCP handshake (`initialize`, `tools/list`, notifications) needs no key.
- Gated tools with missing/malformed/unknown/revoked key → HTTP `401`
  `{error:{code:"UNAUTHORIZED",…}}` (never MCP content errors).
- Every booking tool takes a required `provider_id` (from `list_providers`).
- Tool schemas carry no customer identifier; identity comes only from the key.
- Cross-customer or cross-provider access is denied with uniform not-found
  shapes (`UNKNOWN_BOOKING` / `UNKNOWN_QUOTE`), except a quote booked at the
  wrong provider, which returns `QUOTE_PROVIDER_MISMATCH`.

## Getting a key

- Signup path: `npm run customers -- create --name "…" --phone "…" --email "…"`
  → prints the raw key once.
- Admin path: `npm run keys -- mint <customer-id>`.
- Booking confirmations echo `customer_id` plus `customer_snapshot {name, phone}`.

## Rate limits

- Gated tools: 60 req/min per key. Public surface: 60 req/min per client IP.
- Over either → HTTP `429` + `Retry-After` header. Send
  `X-Forwarded-For: <ip>` in tests to simulate distinct clients.

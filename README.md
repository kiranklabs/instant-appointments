# Instant Appointments — MCP Connector (v3: open marketplace)

Sample MCP connector: anyone can discover local providers and browse
real-time availability with prices (**no key, no signup**); booking,
rescheduling, and cancelling require a free account key. Runs against
fake-but-realistic sample inventory for fictional providers.

- Stack: TypeScript + `@modelcontextprotocol/sdk`, Express, Zod.
- Transport: **streamable HTTP** (`POST /mcp`, stateless, no session IDs).
- Marketplace: providers register in `data/providers.json` (file-backed,
  re-read per request — no restart needed). Each provider brings its own
  services, staff, hours, and sample inventory through the `ProviderAdapter`
  seam (`src/adapters.ts`); only the sample in-memory adapter ships.
- Auth: browsing is public; booking tools require a bearer API key
  (`Authorization: Bearer <key>`), enforced once at the HTTP layer by
  inspecting the JSON-RPC method. Tool schemas carry no customer identifier.
- Store: one in-memory store per provider; availability and booking share the
  same maps per provider, so double-booking is impossible by construction.

## Run

```bash
npm install
npm run keys -- seed-demo   # mint sample keys (shown ONCE; hashes only at rest)
npm run dev        # one command: http://localhost:3000/mcp (+ /health)
PORT=4000 npm run dev
```

Providers (manual onboarding for v3):

```bash
npm run providers -- list
npm run providers -- add --file ./provider.json   # see data/seed-providers/serenity-day-spa.json
npm run providers -- remove <provider_id>
```

Customer signup (v3 path; website self-serve comes later):

```bash
npm run customers -- create --name "Ava Patel" --phone "+14165550101" --email "ava@example.com"
# → creates the profile, mints the API key, prints the raw key ONCE
```

`npm run keys --` stays for admin use (`mint <customer-id>` / `revoke` /
`rotate` / `list`); `customers create` is the normal signup path.

Registry paths: `LUMEN_REGISTRY` (keys, default `data/api-keys.json`),
`LUMEN_CUSTOMERS` (profiles, default `data/customers.json`),
`LUMEN_PROVIDERS` (default `data/providers.json`). All re-read per request.

Browsing needs no key; booking tools send it:

```bash
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_services","arguments":{"provider_id":"lumen-hair-studio"}}}'

curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer lumen_<your-key>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"book_appointment","arguments":{"provider_id":"lumen-hair-studio","quote_id":"..."}}}'
```

Verify:

```bash
npm test           # 50 vitest tests: T1-T6 + 10 auth-security + 11 multi-provider + 13 marketplace
npm run smoke      # keyless browsing + keyed booking over real MCP HTTP (401/200 gates + spa)
npx tsc --noEmit -p tsconfig.json
```

Expose to Meta's servers for review (v1 hosting: local + ngrok):

```bash
ngrok http 3000    # hand Meta the https URL; MCP endpoint is <url>/mcp
```

## Sample world (fixed facts)

Two fictional Toronto providers (both `America/Toronto`):

- **Lumen Hair Studio** (`lumen-hair-studio`, salon, Downtown). Open Tue–Sat
  09:00–18:00, closed Sun/Mon. Services: haircut $45/45min · color $120/120min ·
  blowout $35/30min. Staff: Maya (haircut, color), Jordan (haircut, blowout),
  Priya (color, blowout). First-available staff per start time.
- **Serenity Day Spa** (`serenity-day-spa`, spa, Midtown). Open Tue–Sun
  10:00–20:00, closed Mondays. Services: swedish-massage $90/60min · facial
  $75/45min · aromatherapy $60/30min. Staff: Noor, Sam.
- Slots: 15-minute grid; bookable only if the full service fits before close
  and overlaps no booking or live quote for that staff member.
- Seeds: a handful of pre-existing sample bookings per provider.

## Tool contracts

All prices are CAD cents and **every price carries `price_valid_until`**.
Every booking tool takes a required `provider_id`; unknown ids fail with
`PROVIDER_NOT_FOUND` (no other provider's data in the error). Quotes are
scoped to their issuing provider (`QUOTE_PROVIDER_MISMATCH` on cross use):

| # | Tool | Input | Returns |
|---|------|-------|---------|
| 0 | `list_providers` | `{category?, city?, query?}` (all optional) | `{providers: [{id, name, category, location, contact}]}` |
| 1 | `list_services` | `{provider_id}` | `{services: [...]}` (Brief A shape unchanged per provider) |
| 2 | `check_availability` | `{provider_id, service_id, date (YYYY-MM-DD), preferred_time? (HH:MM)}` | `{date, closed, slots: [{slot_id, service_id, starts_at, ends_at, stylist, price_cents, price_currency, price_valid_until}], alternatives: [{date, slots}], message, price_currency}`. Closed/full days return `slots: []` + nearest alternatives (same service, ±7d), never a bare error. `preferred_time` sorts closest-first. |
| 3 | `create_quote` | `{provider_id, slot_id}` | `{quote_id, service_id, service, slot_id, starts_at, ends_at, stylist, price_cents, price_currency, price_valid_until, valid_until}`. Locks the slot for **15 minutes**. Taken/invalid slots fail as `{ok:false, error:{code, message}, fresh_availability}`. |
| 4 | `book_appointment` | `{provider_id, quote_id}` | Confirmation `{booking_id, quote_id, customer_id, service_id, service, starts_at, ends_at, stylist, price_cents, price_currency, price_valid_until, customer_name, customer_contact, customer_snapshot {name, phone}, status}`. Identity comes from the bearer key; `customer_snapshot` is the record pushed to the provider's system. **Idempotent on `quote_id`** — same quote twice returns the identical confirmation, one booking. Expired quotes fail with `QUOTE_EXPIRED` + `fresh_availability` in the same response. |
| 5 | `reschedule_appointment` | `{provider_id, booking_id, new_slot_id}` | Updated confirmation + `rescheduled_from`; old slot freed. Same service only (else `SERVICE_MISMATCH` + alternatives). |
| 6 | `cancel_appointment` | `{provider_id, booking_id}` | `{cancelled:true, booking_id, freed_slot_id, freed_starts_at, freed_ends_at, …, message}`; slot bookable again. Repeat cancels return the same confirmation (no duplicates). |

`slot_id` format: `Stylist|STARTS_AT_ISO|service_id`
(e.g. `Maya|2026-10-07T10:00:00-04:00|haircut`).

## 1:1 tool → future REST mapping

Each tool maps to one REST endpoint if Meta's directory path wants the
API/custom-connector route:

| MCP tool | Auth | REST endpoint |
|----------|------|---------------|
| `list_providers` | none (public) | `GET /v1/providers?category=&city=&query=` |
| `list_services` | none (public) | `GET /v1/providers/:pid/services` |
| `check_availability` | none (public) | `GET /v1/providers/:pid/availability?service_id=&date=&preferred_time=` |
| `create_quote` | `Authorization: Bearer <key>` | `POST /v1/providers/:pid/quotes {slot_id}` |
| `book_appointment` | `Authorization: Bearer <key>` | `POST /v1/providers/:pid/bookings {quote_id}` (idempotency key: `quote_id`) |
| `reschedule_appointment` | `Authorization: Bearer <key>` | `POST /v1/providers/:pid/bookings/:id/reschedule {new_slot_id}` |
| `cancel_appointment` | `Authorization: Bearer <key>` | `POST /v1/providers/:pid/bookings/:id/cancel` |

Error shape mirrors this: `{ok:false, error:{code, message}, fresh_availability?}`.

## Auth contract

- **Product model:** browsing (`list_providers`, `list_services`,
  `check_availability`, plus the MCP handshake) is fully open — no key, no
  signup. Booking (`create_quote`, `book_appointment`,
  `reschedule_appointment`, `cancel_appointment`) requires a free account key,
  one account for every provider. Rationale: browsing is the acquisition
  funnel; anything that writes or locks inventory requires identity.

| Tool | Auth |
|---|---|
| `list_providers` | none (public) |
| `list_services` | none (public) |
| `check_availability` | none (public) |
| `create_quote` | Bearer API key required |
| `book_appointment` | Bearer API key required |
| `reschedule_appointment` | Bearer API key required |
| `cancel_appointment` | Bearer API key required |

- **How a caller gets a key:** sign up once via `npm run customers -- create
  --name … --phone … --email …` (all three required; website self-serve comes
  later). It creates the profile in `data/customers.json`, mints the key, and
  prints the raw key (`lumen_` + 32 hex chars) **once**; only its SHA-256 hash
  lands in `data/api-keys.json` (see `data/api-keys.example.json`).
  Admin alternative: `npm run keys -- mint <customer-id>`.
- **How a caller sends it:** `Authorization: Bearer <key>` on gated calls.
  Missing, malformed, unknown, or revoked keys all get the identical
  `401 {error:{code:"UNAUTHORIZED",…}}` — the server never reveals whether a
  key exists. Timing-safe hash comparison.
- **Identity:** the customer profile comes *only* from the key (profiles file
  first, seeded sample accounts as fallback). `book_appointment` attaches a
  `customer_snapshot {name, phone}` to the booking — the record the provider's
  system receives. Tool schemas carry no customer identifier: nothing to forge.
- **Isolation deviation (deliberate):** the brief asked for `403 NOT_YOUR_BOOKING`
  on cross-customer reschedule/cancel; this build keeps the uniform not-found
  shape (`UNKNOWN_BOOKING`/`UNKNOWN_QUOTE`) instead, so a forged id reveals
  nothing about other customers' bookings. Denial is by construction (owner
  check on every mutation), not by convention.
- **Rotation/revocation:** `npm run keys -- rotate <customer-id>` /
  `npm run keys -- revoke <customer-id>`. All files are re-read per request,
  so revocation and new signups take effect immediately.
- **Reviewer demo key:** mint with `npm run keys -- mint meta-reviewer` and
  deliver the printed key **in the submission materials only** — never commit
  it to the repo or README.
- **Rate limits:** gated tools — 60 requests/minute per key; public surface —
  60 requests/minute per client IP (`X-Forwarded-For` first hop, else socket).
  Exceeding either returns `429 {error:{code:"RATE_LIMITED",…}}` with a
  `Retry-After` header (seconds). 401s don't consume budget.
- **Future path (multi-store):** OAuth 2.0 / PKCE with Meta account linking;
  bearer keys are the reviewable answer for this demo connector.

## Hosting recommendation

**v1 (review): local + ngrok** — `npm run dev` on `:3000`, expose via
`ngrok http 3000`, hand Meta `<https-url>/mcp`. Why: zero deploy config,
the reviewer hits a live streamable-HTTP endpoint in minutes, and nothing
about the code changes when you promote it.
**Promotion path:** Railway or Render (persistent HTTPS, single service,
`npm start` from `dist/`, env `PORT` + `LUMEN_REGISTRY`/`LUMEN_CUSTOMERS`/`LUMEN_PROVIDERS` pointing at a
persistent volume, keys minted via `npm run keys -- seed-demo`). Both fit because the server is
stateless HTTP with no local state worth preserving — though note the
store is in-memory, so multi-instance production needs a shared DB
(see limitations).

> Meta's connector program is days old: before submitting, re-check the
> current developer docs for anything contradicting this spec — chiefly
> (a) required transport (streamable HTTP vs SSE vs stdio),
> (b) required auth (OAuth vs API key vs none for samples), and
> (c) directory onboarding (MCP URL vs REST/custom-connector). This build
> satisfies the handoff packet as written; doc conflicts should be flagged
> rather than silently followed.

## Limitations (out of scope for v1)

Payments, real salon integrations, multi-store support, reminders,
persistent storage (in-memory only — restarts clear bookings/quotes),
single-instance locking only.

## Test report (T1–T6, S1–S6, Brief A, Brief B — all PASS)

`npm test` (vitest: `test/booking-flow.test.ts` + `test/auth-security.test.ts`
+ `test/providers.test.ts` + `test/marketplace.test.ts`)
+ `npm run smoke` (live split-auth HTTP). Exact steps per case:

| # | Case | Steps | Result |
|---|------|-------|--------|
| T1 | Expired quote booking | quote a color slot → `forceExpireQuote` (simulates 15-min expiry) → `book_appointment` | **PASS** — `QUOTE_EXPIRED` + clear message + `fresh_availability` with slots |
| T2 | Double book request | identical `book_appointment` ×2 | **PASS** — byte-identical confirmations, exactly 1 booking in store |
| T3 | Reschedule to another day | book blowout day A → reschedule to day B slot | **PASS** — new times/stylist returned, old `slot_id` back in day-A availability |
| T4 | Cancel then re-book | book → cancel → quote freed `slot_id` → book | **PASS** — cancellation confirmed, re-book succeeds at same time |
| T5 | Closed day | `check_availability` haircut on a Sunday | **PASS** — `closed:true`, no slots, alternatives offered, no crash |
| T6 | Slot lock contention | quote slot → `check_availability` same window | **PASS** — locked slot hidden; reappears after expiry |

Plus: grid/fit/overlap sweep over all services, full-day fill → adjacent-day
alternatives, `preferred_time` ordering, unknown-service/date/time errors,
unknown quote/booking errors, authenticated-identity confirmations,
cross-customer uniform denial (store level).

| # | Security check | Steps | Result |
|---|----------------|-------|--------|
| S1 | Forged identity (cancel) | key B books → key A cancels → denied; B cancels own booking fine | **PASS** — `UNKNOWN_BOOKING`, B's booking untouched |
| S2 | Missing/garbage header | no header, garbage key, bare `Bearer` | **PASS** — identical `401 UNAUTHORIZED` all three |
| S3 | Revoked key | mint → 200 → revoke → immediate 401 | **PASS** — same `401 UNAUTHORIZED` shape |
| S4 | Idempotent re-book | same quote ×2 same key → identical; other key → denied | **PASS** — one booking, cross-key `UNKNOWN_QUOTE` |
| S5 | Cross-customer reschedule | A books → B reschedules → denied; A cancels own | **PASS** — `UNKNOWN_BOOKING` |
| S6 | Burst rate limit | 4 rapid requests, limit 3/min → 4th rejected | **PASS** — `429 RATE_LIMITED` + `Retry-After` header |

Brief A (`test/providers.test.ts`, 11 checks, all PASS): CLI add/list/remove
round-trip with file re-read; validation rejects bad adapter/timezone/id;
committed `providers.json` Lumen entry equals code (no drift); discovery
filters (category/city/query/empty); all six tools reject unknown
`provider_id` with `PROVIDER_NOT_FOUND` (no data leak); Lumen-vs-spa
availability and closed days differ (Sun vs Mon); cross-scope cancel is
uniform not-found; cross-provider quote booking → `QUOTE_PROVIDER_MISMATCH`;
config hot-reload applies while pre-reload bookings survive.

Brief B (`test/marketplace.test.ts`, 13 checks, all PASS): handshake and
`tools/list` with no header; `list_providers`/`list_services`/
`check_availability` keyless; all four gated tools 401 with no/invalid key;
`customers create` → fresh `cust_*` key books at Lumen with
`customer_snapshot {name, phone}`, manages a spa booking with the same key
(one account, all providers); cross-customer reschedule/cancel denied
(uniform not-found, by Review decision); keyless burst from one IP →
`429 RATE_LIMITED` + `Retry-After`, other IPs unaffected.

## Meta submission draft

**Product description:** Instant Appointments (Toronto) — discover salons and
spas, browse real-time availability with prices with no signup, and book in
one conversational flow with a free account. Quotes hold your slot for
15 minutes; booking is idempotent and rescheduling/cancellation free the slot
instantly. One account works at every provider.

**Usage examples:**

1. "Book me a haircut tomorrow afternoon."
2. "What color appointments do you have Saturday morning, and what do they cost?"
3. "I need a blowout Friday — show me the earliest available."
4. "Move my Thursday booking to next Tuesday."
5. "Cancel my blowout and re-book it for someone else Saturday."

**Tool documentation:** see Tool contracts above; all timestamps ISO 8601
Toronto time; all prices CAD cents with `price_valid_until`.

**Support contact:** <support@example.com> (placeholder — replace before
submission).

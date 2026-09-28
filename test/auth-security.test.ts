// Security tests for the bearer-key upgrade (brief §Security tests).
// HTTP-level: spins createApp() on ephemeral ports with a temp registry.
// Run: npm test
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/index";
import { SALON } from "../src/data";
import {
  hashKey,
  loadRegistryFile,
  mintRawKey,
  saveRegistryFile,
} from "../src/auth";
import { saveProfilesFile } from "../src/customers";
import {
  LUMEN_PROVIDER_ID,
  lumenProvider,
  saveProvidersFile,
} from "../src/providers";
import { addDays, nextOpenDateStr, torontoToday, torontoWeekday } from "../src/time";

const dir = mkdtempSync(join(tmpdir(), "lumen-auth-"));
const registryPath = join(dir, "customers.json");
const providersPath = join(dir, "providers.json");
const customersPath = join(dir, "profiles.json");
// Hermetic provider set: Lumen only (multi-provider cases live in providers.test.ts).
saveProvidersFile(providersPath, { providers: [lumenProvider()] });
saveProfilesFile(customersPath, {
  customers: [
    { customer_id: "ava", name: "Ava Chen", phone: "+1 416-555-0101", email: "ava@example.com", created_at: new Date().toISOString() },
    { customer_id: "leo", name: "Leo Martin", phone: "+1 416-555-0102", email: "leo@example.com", created_at: new Date().toISOString() },
  ],
});

const keyA = mintRawKey();
const keyB = mintRawKey();
saveRegistryFile(registryPath, {
  entries: [
    { customer_id: "ava", key_hash: hashKey(keyA), key_hint: keyA.slice(0, 12), revoked: false, created_at: new Date().toISOString() },
    { customer_id: "leo", key_hash: hashKey(keyB), key_hint: keyB.slice(0, 12), revoked: false, created_at: new Date().toISOString() },
  ],
});

function revokeKey(raw: string) {
  const data = loadRegistryFile(registryPath);
  const digest = hashKey(raw);
  for (const e of data.entries) if (e.key_hash === digest) e.revoked = true;
  saveRegistryFile(registryPath, data);
}

let base = "";
let server: Server;
let limitedBase = "";
let limitedServer: Server;

beforeAll(async () => {
  const app = createApp({ registryPath, customersPath, providersPath, rateLimit: { maxRequests: 1000, windowMs: 60_000 } });
  server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", () => r()));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const limited = createApp({ registryPath, customersPath, providersPath, rateLimit: { maxRequests: 3, windowMs: 60_000 } });
  limitedServer = limited.listen(0);
  await new Promise<void>((r) => limitedServer.on("listening", () => r()));
  limitedBase = `http://localhost:${(limitedServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => limitedServer.close(r));
});

async function post(pathBase: string, body: unknown, key?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (key !== undefined) headers.Authorization = key;
  const res = await fetch(`${pathBase}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  try {
    json = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

let rpcId = 1;
async function call(pathBase: string, tool: string, args: unknown, key?: string) {
  const r = await post(pathBase, {
    jsonrpc: "2.0",
    id: rpcId++,
    method: "tools/call",
    params: { name: tool, arguments: args },
  }, key);
  expect(r.status).toBe(200);
  const result = (r.json as { result: { content: Array<{ text: string }> } }).result;
  return JSON.parse(result.content[0].text);
}

function openDate(offset: number): string {
  return nextOpenDateStr(torontoToday(), offset, SALON.closedWeekdays);
}
function nextSunday(): string {
  let d = addDays(torontoToday(), 1);
  for (let i = 0; i < 14; i++) {
    if (torontoWeekday(d) === 0) return d;
    d = addDays(d, 1);
  }
  throw new Error("no sunday");
}

async function bookFlow(key: string, offset: number, service = "haircut", provider = LUMEN_PROVIDER_ID) {
  const date = openDate(offset);
  const avail = await call(base, "check_availability", { provider_id: provider, service_id: service, date }, `Bearer ${key}`);
  const quote = await call(base, "create_quote", { provider_id: provider, slot_id: avail.slots[0].slot_id }, `Bearer ${key}`);
  const booking = await call(base, "book_appointment", { provider_id: provider, quote_id: quote.quote_id }, `Bearer ${key}`);
  return { date, booking, quote };
}

describe("auth gate", () => {
  // Brief B: browsing (incl. tools/list) is public; gated tools still 401.
  const gatedCall = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "create_quote", arguments: { provider_id: LUMEN_PROVIDER_ID, slot_id: "x" } },
  };
  it("S2: missing header -> 401", async () => {
    const r = await post(base, gatedCall);
    expect(r.status).toBe(401);
    expect(r.json).toEqual({
      error: { code: "UNAUTHORIZED", message: expect.any(String) },
    });
  });
  it("S2: garbage key -> 401, same shape", async () => {
    const r = await post(base, gatedCall, "Bearer garbage-key-123");
    expect(r.status).toBe(401);
    expect(r.json).toEqual({
      error: { code: "UNAUTHORIZED", message: expect.any(String) },
    });
  });
  it("malformed header (no token) -> 401, same shape", async () => {
    const r = await post(base, gatedCall, "Bearer");
    expect(r.status).toBe(401);
    expect(r.json).toEqual({
      error: { code: "UNAUTHORIZED", message: expect.any(String) },
    });
  });
});

describe("ownership", () => {
  it("S1: key A cannot cancel key B's booking (denied, uniform not-found)", async () => {
    const { booking } = await bookFlow(keyB, 9);
    const res = await call(base, "cancel_appointment", { provider_id: LUMEN_PROVIDER_ID, booking_id: booking.booking_id }, `Bearer ${keyA}`);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("UNKNOWN_BOOKING");
    // B's booking is untouched: B can still cancel it.
    const back = await call(base, "cancel_appointment", { provider_id: LUMEN_PROVIDER_ID, booking_id: booking.booking_id }, `Bearer ${keyB}`);
    expect(back.cancelled).toBe(true);
  });
  it("S5: booking under A, reschedule attempted under B -> denied", async () => {
    const { booking } = await bookFlow(keyA, 10);
    const alt = await call(base, "check_availability", { provider_id: LUMEN_PROVIDER_ID, service_id: "haircut", date: openDate(11) }, `Bearer ${keyB}`);
    const res = await call(
      base,
      "reschedule_appointment",
      { provider_id: LUMEN_PROVIDER_ID, booking_id: booking.booking_id, new_slot_id: alt.slots[0].slot_id },
      `Bearer ${keyB}`,
    );
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("UNKNOWN_BOOKING");
    await call(base, "cancel_appointment", { provider_id: LUMEN_PROVIDER_ID, booking_id: booking.booking_id }, `Bearer ${keyA}`);
  });
  it("S4: same quote re-booked under same key -> identical booking, no duplicate", async () => {
    const date = openDate(12);
    const avail = await call(base, "check_availability", { provider_id: LUMEN_PROVIDER_ID, service_id: "blowout", date }, `Bearer ${keyA}`);
    const quote = await call(base, "create_quote", { provider_id: LUMEN_PROVIDER_ID, slot_id: avail.slots[0].slot_id }, `Bearer ${keyA}`);
    const b1 = await call(base, "book_appointment", { provider_id: LUMEN_PROVIDER_ID, quote_id: quote.quote_id }, `Bearer ${keyA}`);
    const b2 = await call(base, "book_appointment", { provider_id: LUMEN_PROVIDER_ID, quote_id: quote.quote_id }, `Bearer ${keyA}`);
    expect(JSON.stringify(b1)).toBe(JSON.stringify(b2));
    // A different key presenting the same quote_id learns nothing, gets nothing.
    const cross = await call(base, "book_appointment", { provider_id: LUMEN_PROVIDER_ID, quote_id: quote.quote_id }, `Bearer ${keyB}`);
    expect(cross.ok).toBe(false);
    expect(cross.error.code).toBe("UNKNOWN_QUOTE");
    await call(base, "cancel_appointment", { provider_id: LUMEN_PROVIDER_ID, booking_id: b1.booking_id }, `Bearer ${keyA}`);
  });
  it("book_appointment schema has no customer fields to forge", async () => {
    const r = await post(base, {
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/list",
      params: {},
    }, `Bearer ${keyA}`);
    const tools = (r.json as { result: { tools: Array<{ name: string; inputSchema: unknown }> } }).result.tools;
    const book = tools.find((t) => t.name === "book_appointment")!;
    const schemaText = JSON.stringify(book.inputSchema);
    expect(schemaText).not.toMatch(/customer_name|customer_contact/);
  });
  it("closed-day + full flow still work under a valid key", async () => {
    const sun = await call(base, "check_availability", { provider_id: LUMEN_PROVIDER_ID, service_id: "haircut", date: nextSunday() }, `Bearer ${keyA}`);
    expect(sun.closed).toBe(true);
    expect(sun.alternatives.length).toBeGreaterThan(0);
  });
});

describe("revocation", () => {
  it("S3: revoked key -> 401 on next request", async () => {
    const tmp = mintRawKey();
    const data = loadRegistryFile(registryPath);
    data.entries.push({
      customer_id: "mia",
      key_hash: hashKey(tmp),
      key_hint: tmp.slice(0, 12),
      revoked: false,
      created_at: new Date().toISOString(),
    });
    saveRegistryFile(registryPath, data);
    // Works before revocation (gated tool with valid key -> 200).
    const gatedCall = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_quote", arguments: { provider_id: LUMEN_PROVIDER_ID, slot_id: "x" } },
    };
    const ok = await post(base, gatedCall, `Bearer ${tmp}`);
    expect(ok.status).toBe(200);
    revokeKey(tmp);
    const denied = await post(base, { ...gatedCall, id: 2 }, `Bearer ${tmp}`);
    expect(denied.status).toBe(401);
    expect(denied.json).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
  });
});

describe("rate limiting", () => {
  it("S6: burst -> 429 with Retry-After", async () => {
    // Gated tool under a key: per-key budget trips (all reach dispatch -> 200).
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_quote", arguments: { provider_id: LUMEN_PROVIDER_ID, slot_id: "x" } },
    };
    for (let i = 0; i < 3; i++) {
      const r = await post(limitedBase, body, `Bearer ${keyA}`);
      expect(r.status).toBe(200);
    }
    const over = await post(limitedBase, body, `Bearer ${keyA}`);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(over.json).toEqual({ error: { code: "RATE_LIMITED", message: expect.any(String) } });
  });
});

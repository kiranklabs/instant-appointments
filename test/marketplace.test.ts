// Brief B tests: open browsing + account-gated booking.
// - Public tools work with no Authorization header (per-IP rate limit).
// - Gated tools 401 without/invalid key (per-key rate limit).
// - `customers create` signup -> key books on any provider; snapshot attached.
// Run: npm test
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/index";
import { hashKey, mintRawKey, saveRegistryFile } from "../src/auth";
import { saveProfilesFile } from "../src/customers";
import { lumenProvider, saveProvidersFile, type Provider } from "../src/providers";
import { nextOpenDateStr, torontoToday } from "../src/time";
import { SALON } from "../src/data";

const LUMEN = "lumen-hair-studio";
const SPA = "serenity-day-spa";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const spaSeed: Provider = JSON.parse(
  readFileSync(join(repoRoot, "data/seed-providers/serenity-day-spa.json"), "utf8"),
);

const dir = mkdtempSync(join(tmpdir(), "lumen-market-"));
const registryPath = join(dir, "keys.json");
const customersPath = join(dir, "profiles.json");
const providersPath = join(dir, "providers.json");

const keyA = mintRawKey();
const keyB = mintRawKey();
saveRegistryFile(registryPath, {
  entries: [
    { customer_id: "ava", key_hash: hashKey(keyA), key_hint: keyA.slice(0, 12), revoked: false, created_at: new Date().toISOString() },
    { customer_id: "leo", key_hash: hashKey(keyB), key_hint: keyB.slice(0, 12), revoked: false, created_at: new Date().toISOString() },
  ],
});
saveProfilesFile(customersPath, {
  customers: [
    { customer_id: "ava", name: "Ava Chen", phone: "+1 416-555-0101", email: "ava@example.com", created_at: new Date().toISOString() },
    { customer_id: "leo", name: "Leo Martin", phone: "+1 416-555-0102", email: "leo@example.com", created_at: new Date().toISOString() },
  ],
});
saveProvidersFile(providersPath, { providers: [lumenProvider(), spaSeed] });

let base = "";
let server: Server;
let limitedBase = "";
let limitedServer: Server;

beforeAll(async () => {
  const app = createApp({
    registryPath,
    customersPath,
    providersPath,
    rateLimit: { maxRequests: 1000, windowMs: 60_000 },
    ipRateLimit: { maxRequests: 1000, windowMs: 60_000 },
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", () => r()));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const limited = createApp({
    registryPath,
    customersPath,
    providersPath,
    rateLimit: { maxRequests: 1000, windowMs: 60_000 },
    ipRateLimit: { maxRequests: 3, windowMs: 60_000 },
  });
  limitedServer = limited.listen(0);
  await new Promise<void>((r) => limitedServer.on("listening", () => r()));
  limitedBase = `http://localhost:${(limitedServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => limitedServer.close(r));
});

async function post(pathBase: string, body: unknown, key?: string, ip?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (key !== undefined) headers.Authorization = key;
  if (ip !== undefined) headers["X-Forwarded-For"] = ip;
  const res = await fetch(`${pathBase}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  let json: unknown = null;
  try {
    json = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json };
}

let rpcId = 900;
async function call(pathBase: string, tool: string, args: unknown, key?: string, ip?: string) {
  const r = await post(
    pathBase,
    { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: tool, arguments: args } },
    key,
    ip,
  );
  expect(r.status).toBe(200);
  const result = (r.json as { result: { content: Array<{ text: string }> } }).result;
  return JSON.parse(result.content[0].text);
}
// Public browsing: no Authorization header at all.
const browse = (tool: string, args: unknown, ip?: string) => call(base, tool, args, undefined, ip);
// Keyed booking flow.
const keyed = (tool: string, args: unknown, key: string) => call(base, tool, args, `Bearer ${key}`);

function openDate(offset: number): string {
  return nextOpenDateStr(torontoToday(), offset, SALON.closedWeekdays);
}

describe("open browsing (no key)", () => {
  it("handshake + tools/list work without Authorization", async () => {
    const init = await post(base, {
      jsonrpc: "2.0",
      id: rpcId++,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(init.status).toBe(200);
    const list = await post(base, { jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    const names = (list.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).toContain("list_providers");
    expect(names).toHaveLength(7);
  });
  it("list_providers / list_services / check_availability need no key", async () => {
    const provs = await browse("list_providers", {});
    expect(provs.providers.map((p: { id: string }) => p.id).sort()).toEqual([LUMEN, SPA]);
    const svcs = await browse("list_services", { provider_id: LUMEN });
    expect(svcs.services).toHaveLength(3);
    const avail = await browse("check_availability", {
      provider_id: SPA,
      service_id: "facial",
      date: openDate(14),
    });
    expect(avail.slots.length).toBeGreaterThan(0);
  });
});

describe("gated booking (key required)", () => {
  const gated: Array<[string, unknown]> = [
    ["create_quote", { provider_id: LUMEN, slot_id: "x" }],
    ["book_appointment", { provider_id: LUMEN, quote_id: "x" }],
    ["reschedule_appointment", { provider_id: LUMEN, booking_id: "x", new_slot_id: "x" }],
    ["cancel_appointment", { provider_id: LUMEN, booking_id: "x" }],
  ];
  it.each(gated)("401 with no key: %s", async (tool, args) => {
    const r = await post(base, {
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name: tool, arguments: args },
    });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
  });
  it.each(gated)("401 with invalid key: %s", async (tool, args) => {
    const r = await post(
      base,
      { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: tool, arguments: args } },
      "Bearer bogus",
    );
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
  });
});

describe("signup + one account everywhere", () => {
  it("customers create -> key books; record carries the customer snapshot", async () => {
    const OLD_KEYS = process.env.LUMEN_REGISTRY;
    const OLD_PROFILES = process.env.LUMEN_CUSTOMERS;
    process.env.LUMEN_REGISTRY = registryPath;
    process.env.LUMEN_CUSTOMERS = customersPath;
    try {
      vi.resetModules();
      const cli = await import("../src/customers-cli");
      const { profile, rawKey } = cli.signupCustomer({
        name: "Ava Patel",
        phone: "+14165550101",
        email: "ava.patel@example.com",
      });
      expect(profile.customer_id).toMatch(/^cust_[0-9a-f]{6}$/);
      // Full keyed flow on Lumen with the fresh account.
      const date = openDate(15);
      const avail = await keyed("check_availability", { provider_id: LUMEN, service_id: "haircut", date }, rawKey);
      const quote = await keyed("create_quote", { provider_id: LUMEN, slot_id: avail.slots[0].slot_id }, rawKey);
      const booking = await keyed("book_appointment", { provider_id: LUMEN, quote_id: quote.quote_id }, rawKey);
      expect(booking.customer_id).toBe(profile.customer_id);
      expect(booking.customer_snapshot).toEqual({ name: "Ava Patel", phone: "+14165550101" });
      // Same key manages a booking at the spa too: one account, all providers.
      const spaAvail = await keyed(
        "check_availability",
        { provider_id: SPA, service_id: "aromatherapy", date: openDate(16) },
        rawKey,
      );
      const spaQuote = await keyed(
        "create_quote",
        { provider_id: SPA, slot_id: spaAvail.slots[0].slot_id },
        rawKey,
      );
      const spaBooking = await keyed("book_appointment", { provider_id: SPA, quote_id: spaQuote.quote_id }, rawKey);
      expect(spaBooking.customer_id).toBe(profile.customer_id);
      expect(spaBooking.customer_snapshot).toEqual({ name: "Ava Patel", phone: "+14165550101" });
      // Cleanup both.
      expect((await keyed("cancel_appointment", { provider_id: LUMEN, booking_id: booking.booking_id }, rawKey)).cancelled).toBe(true);
      expect((await keyed("cancel_appointment", { provider_id: SPA, booking_id: spaBooking.booking_id }, rawKey)).cancelled).toBe(true);
    } finally {
      if (OLD_KEYS === undefined) delete process.env.LUMEN_REGISTRY;
      else process.env.LUMEN_REGISTRY = OLD_KEYS;
      if (OLD_PROFILES === undefined) delete process.env.LUMEN_CUSTOMERS;
      else process.env.LUMEN_CUSTOMERS = OLD_PROFILES;
      vi.resetModules();
    }
  });

  it("customer A cannot reschedule/cancel customer B's booking", async () => {
    const date = openDate(17);
    const avail = await keyed("check_availability", { provider_id: LUMEN, service_id: "haircut", date }, keyB);
    const quote = await keyed("create_quote", { provider_id: LUMEN, slot_id: avail.slots[0].slot_id }, keyB);
    const booking = await keyed("book_appointment", { provider_id: LUMEN, quote_id: quote.quote_id }, keyB);
    const alt = await keyed(
      "check_availability",
      { provider_id: LUMEN, service_id: "haircut", date: openDate(18) },
      keyA,
    );
    const re = await keyed(
      "reschedule_appointment",
      { provider_id: LUMEN, booking_id: booking.booking_id, new_slot_id: alt.slots[0].slot_id },
      keyA,
    );
    expect(re.ok).toBe(false);
    expect(re.error.code).toBe("UNKNOWN_BOOKING");
    const cancel = await keyed("cancel_appointment", { provider_id: LUMEN, booking_id: booking.booking_id }, keyA);
    expect(cancel.ok).toBe(false);
    expect(cancel.error.code).toBe("UNKNOWN_BOOKING");
    expect((await keyed("cancel_appointment", { provider_id: LUMEN, booking_id: booking.booking_id }, keyB)).cancelled).toBe(true);
  });
});

describe("public IP rate limiting", () => {
  it("bursts of keyless browsing trip 429 with Retry-After", async () => {
    const body = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params: {},
    });
    for (let i = 0; i < 3; i++) {
      const r = await post(limitedBase, body(i), undefined, "203.0.113.7");
      expect(r.status).toBe(200);
    }
    const over = await post(limitedBase, body(99), undefined, "203.0.113.7");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(over.json).toEqual({ error: { code: "RATE_LIMITED", message: expect.any(String) } });
    // A different IP is unaffected.
    const other = await post(limitedBase, body(100), undefined, "203.0.113.8");
    expect(other.status).toBe(200);
  });
});

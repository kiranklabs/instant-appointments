// Brief A tests: multi-provider core (registry, discovery, isolation).
// HTTP-level via createApp() on ephemeral ports; CLI functions directly.
// Run: npm test
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/index";
import { customerById } from "../src/auth";
import {
  hashKey,
  mintRawKey,
  saveRegistryFile,
} from "../src/auth";
import {
  LUMEN_PROVIDER_ID,
  filterProviders,
  loadProvidersFile,
  lumenProvider,
  saveProvidersFile,
  validateProvider,
  type Provider,
} from "../src/providers";
import { SampleDirectory } from "../src/adapters";
import { saveProfilesFile } from "../src/customers";
import { addDays, nextOpenDateStr, torontoToday, torontoWeekday } from "../src/time";
import { SALON } from "../src/data";

const LUMEN = LUMEN_PROVIDER_ID;
const SPA = "serenity-day-spa";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const spaSeed: Provider = JSON.parse(
  readFileSync(join(repoRoot, "data/seed-providers/serenity-day-spa.json"), "utf8"),
);

const dir = mkdtempSync(join(tmpdir(), "lumen-providers-"));
const registryPath = join(dir, "customers.json");
const providersPath = join(dir, "providers.json");
const customersPath = join(dir, "profiles.json");

const keyA = mintRawKey();
saveRegistryFile(registryPath, {
  entries: [
    { customer_id: "ava", key_hash: hashKey(keyA), key_hint: keyA.slice(0, 12), revoked: false, created_at: new Date().toISOString() },
  ],
});
saveProvidersFile(providersPath, { providers: [lumenProvider(), spaSeed] });
saveProfilesFile(customersPath, {
  customers: [
    { customer_id: "ava", name: "Ava Chen", phone: "+1 416-555-0101", email: "ava@example.com", created_at: new Date().toISOString() },
  ],
});

let base = "";
let server: Server;

beforeAll(async () => {
  const app = createApp({ registryPath, customersPath, providersPath, rateLimit: { maxRequests: 1000, windowMs: 60_000 } });
  server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", () => r()));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function post(body: unknown, key?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (key !== undefined) headers.Authorization = key;
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  let json: unknown = null;
  try {
    json = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

let rpcId = 500;
async function call(tool: string, args: unknown) {
  const r = await post(
    { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: tool, arguments: args } },
    `Bearer ${keyA}`,
  );
  expect(r.status).toBe(200);
  const result = (r.json as { result: { content: Array<{ text: string }> } }).result;
  return JSON.parse(result.content[0].text);
}

function openDate(offset: number): string {
  return nextOpenDateStr(torontoToday(), offset, SALON.closedWeekdays);
}
function nextWeekday(want: number): string {
  let d = addDays(torontoToday(), 1);
  for (let i = 0; i < 14; i++) {
    if (torontoWeekday(d) === want) return d;
    d = addDays(d, 1);
  }
  throw new Error("weekday not found");
}

describe("provider registry (CLI functions)", () => {
  it("add/list/remove round-trip; file re-read picks up changes", async () => {
    const tmp = join(dir, "crud.json");
    saveProvidersFile(tmp, { providers: [] });
    const OLD = process.env.LUMEN_PROVIDERS;
    process.env.LUMEN_PROVIDERS = tmp;
    try {
      vi.resetModules();
      const cli = await import("../src/providers-cli");
      expect(cli.listProviders()).toHaveLength(0);
      const added = cli.addProvider(spaSeed);
      expect(added.id).toBe(SPA);
      expect(cli.listProviders().map((p) => p.id)).toEqual([SPA]);
      // Re-read from disk sees the same record (no restart needed).
      expect(loadProvidersFile(tmp).providers.map((p) => p.id)).toEqual([SPA]);
      // Duplicate add is rejected; bad record is rejected.
      expect(() => cli.addProvider(spaSeed)).toThrow(/already exists/);
      expect(() => cli.addProvider({ id: "bad!" })).toThrow(/Invalid provider/);
      expect(cli.removeProvider("missing")).toBe(false);
      expect(cli.removeProvider(SPA)).toBe(true);
      expect(cli.listProviders()).toHaveLength(0);
      expect(loadProvidersFile(tmp).providers).toHaveLength(0);
    } finally {
      if (OLD === undefined) delete process.env.LUMEN_PROVIDERS;
      else process.env.LUMEN_PROVIDERS = OLD;
      vi.resetModules();
    }
  });

  it("validateProvider rejects bad records", () => {
    expect(validateProvider(null)).not.toHaveLength(0);
    expect(validateProvider({ ...lumenProvider(), adapter: "salesforce" })).not.toHaveLength(0);
    expect(validateProvider({ ...lumenProvider(), timezone: "Mars/Olympus" })).not.toHaveLength(0);
    expect(validateProvider({ ...lumenProvider(), id: "Bad ID!" })).not.toHaveLength(0);
    expect(validateProvider(lumenProvider())).toHaveLength(0);
    expect(validateProvider(spaSeed)).toHaveLength(0);
  });

  it("committed data/providers.json contains the Lumen record with no drift", () => {
    const committed = loadProvidersFile(join(repoRoot, "data/providers.json"));
    const lumen = committed.providers.find((p) => p.id === LUMEN);
    expect(lumen).toBeDefined();
    expect(lumen).toEqual(lumenProvider());
    // Spa was registered via the CLI path.
    expect(committed.providers.some((p) => p.id === SPA)).toBe(true);
  });

  it("filterProviders: category, city, query, empty", () => {
    const all = [lumenProvider(), spaSeed];
    expect(filterProviders(all, {})).toHaveLength(2);
    expect(filterProviders(all, { category: "spa" }).map((p) => p.id)).toEqual([SPA]);
    expect(filterProviders(all, { category: "SALON" }).map((p) => p.id)).toEqual([LUMEN]);
    expect(filterProviders(all, { city: "toronto" })).toHaveLength(2);
    expect(filterProviders(all, { city: "Vancouver" })).toHaveLength(0);
    expect(filterProviders(all, { query: "serenity" }).map((p) => p.id)).toEqual([SPA]);
    expect(filterProviders(all, { query: "salon" }).map((p) => p.id)).toEqual([LUMEN]);
  });
});

describe("list_providers tool", () => {
  it("empty input lists all; summaries carry no inventory data", async () => {
    const res = await call("list_providers", {});
    expect(res.providers.map((p: { id: string }) => p.id).sort()).toEqual([LUMEN, SPA]);
    for (const p of res.providers) {
      expect(Object.keys(p).sort()).toEqual(["category", "contact", "id", "location", "name"]);
    }
  });
  it("filters work over HTTP", async () => {
    expect((await call("list_providers", { category: "spa" })).providers.map((p: { id: string }) => p.id)).toEqual([SPA]);
    expect((await call("list_providers", { city: "Toronto" })).providers).toHaveLength(2);
    expect((await call("list_providers", { query: "lumen" })).providers.map((p: { id: string }) => p.id)).toEqual([LUMEN]);
    expect((await call("list_providers", { query: "clinic" })).providers).toHaveLength(0);
  });
});

describe("provider_id routing", () => {
  it("all six tools reject unknown provider_id with PROVIDER_NOT_FOUND", async () => {
    const bad = "no-such-provider";
    const cases: Array<[string, unknown]> = [
      ["list_services", { provider_id: bad }],
      ["check_availability", { provider_id: bad, service_id: "haircut", date: openDate(5) }],
      ["create_quote", { provider_id: bad, slot_id: "x" }],
      ["book_appointment", { provider_id: bad, quote_id: "x" }],
      ["reschedule_appointment", { provider_id: bad, booking_id: "x", new_slot_id: "x" }],
      ["cancel_appointment", { provider_id: bad, booking_id: "x" }],
    ];
    for (const [tool, args] of cases) {
      const res = await call(tool, args);
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("PROVIDER_NOT_FOUND");
      // No other provider's data leaks into the error.
      expect(JSON.stringify(res)).not.toMatch(/Maya|Noor|haircut|swedish/);
    }
  });

  it("availability differs per provider; closed days differ", async () => {
    const date = openDate(6);
    const lumen = await call("check_availability", { provider_id: LUMEN, service_id: "haircut", date });
    const spa = await call("check_availability", { provider_id: SPA, service_id: "swedish-massage", date });
    expect(lumen.slots.length).toBeGreaterThan(0);
    expect(spa.slots.length).toBeGreaterThan(0);
    expect(lumen.slots[0].stylist).not.toBe(spa.slots[0].stylist);
    expect(lumen.slots[0].price_cents).not.toBe(spa.slots[0].price_cents);
    // Lumen closed Sundays, spa open Sundays (closed Mondays only).
    const sunday = nextWeekday(0);
    const lumenSun = await call("check_availability", { provider_id: LUMEN, service_id: "haircut", date: sunday });
    const spaSun = await call("check_availability", { provider_id: SPA, service_id: "facial", date: sunday });
    expect(lumenSun.closed).toBe(true);
    expect(lumenSun.message).toMatch(/Sundays and Mondays/);
    expect(spaSun.closed).toBe(false);
    expect(spaSun.slots.length).toBeGreaterThan(0);
    const monday = nextWeekday(1);
    const spaMon = await call("check_availability", { provider_id: SPA, service_id: "facial", date: monday });
    expect(spaMon.closed).toBe(true);
    expect(spaMon.message).toMatch(/Mondays/);
  });
});

describe("data isolation", () => {
  it("Lumen booking invisible to spa-scoped queries and vice versa", async () => {
    const date = openDate(7);
    const avail = await call("check_availability", { provider_id: LUMEN, service_id: "haircut", date });
    const quote = await call("create_quote", { provider_id: LUMEN, slot_id: avail.slots[0].slot_id });
    const booking = await call("book_appointment", { provider_id: LUMEN, quote_id: quote.quote_id });
    // Same booking_id through the spa scope: uniform not-found, no leak.
    const cross = await call("cancel_appointment", { provider_id: SPA, booking_id: booking.booking_id });
    expect(cross.ok).toBe(false);
    expect(cross.error.code).toBe("UNKNOWN_BOOKING");
    // Spa inventory untouched by the Lumen booking.
    const spaAvail = await call("check_availability", { provider_id: SPA, service_id: "aromatherapy", date });
    expect(spaAvail.slots.length).toBeGreaterThan(0);
    // Owner cancels through the correct scope.
    const back = await call("cancel_appointment", { provider_id: LUMEN, booking_id: booking.booking_id });
    expect(back.cancelled).toBe(true);
  });

  it("quote issued by Lumen cannot be booked against the spa", async () => {
    const date = openDate(8);
    const avail = await call("check_availability", { provider_id: LUMEN, service_id: "blowout", date });
    const quote = await call("create_quote", { provider_id: LUMEN, slot_id: avail.slots[0].slot_id });
    const res = await call("book_appointment", { provider_id: SPA, quote_id: quote.quote_id });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("QUOTE_PROVIDER_MISMATCH");
    // The quote still books fine at its issuing provider.
    const ok = await call("book_appointment", { provider_id: LUMEN, quote_id: quote.quote_id });
    expect(ok.booking_id).toBeDefined();
    await call("cancel_appointment", { provider_id: LUMEN, booking_id: ok.booking_id });
  });
});

describe("hot reload preserves inventory", () => {
  it("config change applies; pre-reload booking survives", () => {
    const ava = customerById("ava")!;
    const directory = new SampleDirectory();
    directory.sync([lumenProvider()]);
    const adapter = directory.get(LUMEN)!;
    expect(adapter.listServices().services[0].price_cents).toBe(4500);
    // Book before the reload.
    const date = nextOpenDateStr(torontoToday(), 9, [0, 1]);
    const avail = adapter.checkAvailability("haircut", date);
    if ("ok" in avail) throw new Error("availability failed");
    const quote = adapter.createQuote(avail.slots[0].slot_id, ava);
    if ("ok" in quote) throw new Error("quote failed");
    const booking = adapter.bookAppointment(quote.quote_id, ava);
    if ("ok" in booking) throw new Error("book failed");
    // Reload with a changed price: applies to new reads…
    const changed: Provider = {
      ...lumenProvider(),
      config: {
        ...lumenProvider().config,
        services: [{ ...lumenProvider().config.services[0], price_cents: 5000 }],
      },
    };
    directory.sync([changed]);
    expect(adapter.listServices().services[0].price_cents).toBe(5000);
    // …while the pre-reload booking is intact on the same adapter.
    const cancelled = adapter.cancelAppointment(booking.booking_id, ava);
    if ("ok" in cancelled) throw new Error("cancel failed");
    expect(cancelled.cancelled).toBe(true);
  });
});

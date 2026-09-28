// End-to-end smoke over real MCP streamable HTTP (authenticated).
// Usage: PORT=3457 LUMEN_KEY=lumen_... node scripts/smoke.mjs
// (server must already be running; `npm run smoke` wires this up.)
const BASE = `http://localhost:${process.env.PORT ?? 3457}`;
const KEY = process.env.LUMEN_KEY;
if (!KEY) {
  console.error("FAIL  LUMEN_KEY env var is required (bearer key for the smoke customer)");
  process.exit(1);
}
let id = 100;

async function rpc(method, params, withKey = true) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (withKey) headers.Authorization = `Bearer ${KEY}`;
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  if (res.status === 401 || res.status === 429) {
    throw new Error(`RPC ${method} rejected: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`no SSE data in response: ${text.slice(0, 200)}`);
  const msg = JSON.parse(line.slice(6));
  if (msg.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

async function call(tool, args, withKey = true) {
  const r = await rpc("tools/call", { name: tool, arguments: args }, withKey);
  return JSON.parse(r.content[0].text);
}

// Browsing is public (no key); booking is gated (key).
const browse = (tool, args) => call(tool, args, false);

function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) process.exitCode = 1;
}

// Next Tue-Sat date as YYYY-MM-DD (salon is closed Sun/Mon).
function openDate(offset = 5) {
  const d = new Date();
  let seen = -1;
  while (seen < offset) {
    d.setDate(d.getDate() + 1);
    const dow = new Date(d.toLocaleString("en-US", { timeZone: "America/Toronto" })).getDay();
    // Approximate: use UTC day; corrected below by closed flag from server.
    if (d.getDay() !== 0 && d.getDay() !== 1) seen++;
  }
  return d.toISOString().slice(0, 10);
}
function nextSunday() {
  const d = new Date();
  for (let i = 1; i <= 14; i++) {
    const c = new Date(d);
    c.setDate(d.getDate() + i);
    if (c.getDay() === 0) return c.toISOString().slice(0, 10);
  }
  throw new Error("no sunday");
}

const health = await (await fetch(`${BASE}/health`)).json();
check("health", health.ok === true);

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0.0.1" },
});
check("initialize", init.serverInfo?.name === "instant-appointments");

const tools = await rpc("tools/list", {});
check("seven tools exposed", tools.tools?.length === 7, (tools.tools ?? []).map((t) => t.name).join(","));

const P = "lumen-hair-studio";
const provs = await browse("list_providers", {});
check("list_providers finds lumen + spa (keyless)", provs.providers.length >= 2);

const { services } = await browse("list_services", { provider_id: P });
check("list_services: 3 services (keyless)", services.length === 3);

const dayA = openDate(5);
const dayB = openDate(6);
const avail = await browse("check_availability", { provider_id: P, service_id: "haircut", date: dayA });
check("availability returns slots", avail.slots.length > 0, `${avail.slots.length} slots on ${dayA}`);

const slot = avail.slots[0];
const quote = await call("create_quote", { provider_id: P, slot_id: slot.slot_id });
check("create_quote locks slot", !!quote.quote_id);

const during = await browse("check_availability", { provider_id: P, service_id: "haircut", date: dayA });
check("T6 locked slot hidden", !during.slots.map((s) => s.slot_id).includes(slot.slot_id));

const b1 = await call("book_appointment", { provider_id: P, quote_id: quote.quote_id });
const b2 = await call("book_appointment", { provider_id: P, quote_id: quote.quote_id });
check("T2 idempotent double-book", JSON.stringify(b1) === JSON.stringify(b2));

const availB = await browse("check_availability", { provider_id: P, service_id: "haircut", date: dayB });
const moved = await call("reschedule_appointment", {
  provider_id: P,
  booking_id: b1.booking_id,
  new_slot_id: availB.slots[0].slot_id,
});
check("T3 reschedule cross-day", moved.starts_at === availB.slots[0].starts_at);
const backA = await browse("check_availability", { provider_id: P, service_id: "haircut", date: dayA });
check("T3 old slot freed", backA.slots.map((s) => s.slot_id).includes(slot.slot_id));

const cancelled = await call("cancel_appointment", { provider_id: P, booking_id: b1.booking_id });
check("T4 cancel confirms", cancelled.cancelled === true);
const q2 = await call("create_quote", { provider_id: P, slot_id: slot.slot_id });
const re = await call("book_appointment", { provider_id: P, quote_id: q2.quote_id });
check("T4 re-book freed slot", re.starts_at === slot.starts_at);

const sunday = await browse("check_availability", { provider_id: P, service_id: "haircut", date: nextSunday() });
check("T5 closed Sunday + alternatives", sunday.closed === true && sunday.alternatives.length > 0);

// Brief A: second provider coexists with its own inventory.
const spaAvail = await browse("check_availability", { provider_id: "serenity-day-spa", service_id: "facial", date: dayA });
check("spa availability differs", spaAvail.slots.length > 0 && spaAvail.slots[0].stylist !== "Maya");
const spaQuote = await call("create_quote", { provider_id: "serenity-day-spa", slot_id: spaAvail.slots[0].slot_id });
const mismatch = await call("book_appointment", { provider_id: P, quote_id: spaQuote.quote_id });
check("cross-provider quote rejected", mismatch.ok === false && mismatch.error.code === "QUOTE_PROVIDER_MISMATCH");

console.log("smoke done (T1 expired-quote-over-HTTP skipped: covered in vitest via forceExpireQuote)");

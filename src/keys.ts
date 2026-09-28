// Admin key management CLI. NOT an MCP tool — key issuance, revocation,
// and rotation must stay out of the connector's tool surface.
//
// Usage:
//   npm run keys -- mint <customer-id>
//   npm run keys -- revoke <customer-id>
//   npm run keys -- rotate <customer-id>
//   npm run keys -- list
//   npm run keys -- seed-demo
//
// Sample customer ids: ava, leo, mia, meta-reviewer (plus any id created
// via `npm run customers -- create`).
// Key registry: LUMEN_REGISTRY env or data/api-keys.json (hashes only).
// Profiles: LUMEN_CUSTOMERS env or data/customers.json.

import {
  SEEDED_CUSTOMERS,
  customerById,
  hashKey,
  loadRegistryFile,
  mintRawKey,
  saveRegistryFile,
} from "./auth.js";
import { getProfile } from "./customers.js";

const registryPath = process.env.LUMEN_REGISTRY ?? "data/api-keys.json";
const customersPath = process.env.LUMEN_CUSTOMERS ?? "data/customers.json";

function usage(): never {
  console.error(
    "Usage: npm run keys -- <mint|revoke|rotate|list|seed-demo> [customer-id]",
  );
  process.exit(1);
}

function mintFor(customerId: string): string {
  // Admin path accepts seeded sample ids and signed-up profile ids.
  const known = customerById(customerId) ?? getProfile(customersPath, customerId);
  if (!known) {
    console.error(
      `Unknown customer "${customerId}". Sample ids: ${SEEDED_CUSTOMERS.map((c) => c.id).join(", ")} (or create one: npm run customers -- create ...)`,
    );
    process.exit(1);
  }
  const data = loadRegistryFile(registryPath);
  const active = data.entries.filter((e) => e.customer_id === customerId && !e.revoked);
  if (active.length > 0) {
    console.error(
      `Customer "${customerId}" already has an active key (${active.map((e) => e.key_hint).join(", ")}). Use "rotate" to replace it.`,
    );
    process.exit(1);
  }
  const raw = mintRawKey();
  data.entries.push({
    customer_id: customerId,
    key_hash: hashKey(raw),
    key_hint: raw.slice(0, 12),
    revoked: false,
    created_at: new Date().toISOString(),
  });
  saveRegistryFile(registryPath, data);
  return raw;
}

function revokeAll(customerId: string): number {
  const data = loadRegistryFile(registryPath);
  let n = 0;
  for (const e of data.entries) {
    if (e.customer_id === customerId && !e.revoked) {
      e.revoked = true;
      n++;
    }
  }
  saveRegistryFile(registryPath, data);
  return n;
}

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case "mint": {
    if (!arg) usage();
    const raw = mintFor(arg);
    console.log(`Key for "${arg}" (shown ONCE — store it securely, only the hash is kept):`);
    console.log(raw);
    break;
  }
  case "revoke": {
    if (!arg) usage();
    const n = revokeAll(arg);
    console.log(`Revoked ${n} key(s) for "${arg}". Takes effect on the next request.`);
    break;
  }
  case "rotate": {
    if (!arg) usage();
    revokeAll(arg);
    const raw = mintFor(arg);
    console.log(`Rotated. New key for "${arg}" (shown ONCE):`);
    console.log(raw);
    break;
  }
  case "list": {
    const data = loadRegistryFile(registryPath);
    if (data.entries.length === 0) {
      console.log(`No keys in ${registryPath}. Run: npm run keys -- seed-demo`);
      break;
    }
    for (const e of data.entries) {
      console.log(
        `${e.customer_id}\t${e.key_hint}…\t${e.revoked ? "revoked" : "active"}\t${e.created_at}`,
      );
    }
    break;
  }
  case "seed-demo": {
    // Mint keys for every seeded sample customer lacking one (incl. the
    // Meta reviewer demo customer). Deliver the reviewer key in the
    // submission materials — never commit it.
    for (const c of SEEDED_CUSTOMERS) {
      const data = loadRegistryFile(registryPath);
      if (data.entries.some((e) => e.customer_id === c.id && !e.revoked)) {
        console.log(`${c.id}: already has an active key, skipped`);
        continue;
      }
      const raw = mintFor(c.id);
      console.log(`${c.id}: ${raw}   <-- shown ONCE`);
    }
    break;
  }
  default:
    usage();
}

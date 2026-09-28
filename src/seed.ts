// Boot seeding for hosted environments (e.g. Render free tier with an
// ephemeral filesystem, wiped on every redeploy/restart/spin-down).
// Ensures the three file-backed registries exist before the server listens:
// providers (Lumen + spa from the committed seed file), customer profiles
// (seeded sample accounts), and the key registry. Hashed seed keys from the
// committed data/api-keys.seed.json are restored whenever the live registry
// lacks an active entry for that customer — so a fixed reviewer key survives
// wipes (only hashes are committed; raw keys are never in the repo).
// LUMEN_SEED_KEYS tops up any other listed accounts missing a key; raw
// minted keys print to stdout ONCE — copy them from the deploy logs, then
// they live only as hashes.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SEEDED_CUSTOMERS,
  hashKey,
  loadRegistryFile,
  mintRawKey,
  saveRegistryFile,
} from "./auth.js";
import { loadProfilesFile, saveProfilesFile } from "./customers.js";
import { loadProvidersFile, lumenProvider, saveProvidersFile, type Provider } from "./providers.js";

export interface DataPaths {
  keysPath: string;
  customersPath: string;
  providersPath: string;
}

function repoSpaSeed(): Provider | null {
  try {
    const raw = readFileSync(join(process.cwd(), "data/seed-providers/serenity-day-spa.json"), "utf8");
    return JSON.parse(raw) as Provider;
  } catch {
    return null;
  }
}

function ensureProviders(providersPath: string): void {
  if (existsSync(providersPath)) return;
  const providers = [lumenProvider()];
  const spa = repoSpaSeed();
  if (spa) providers.push(spa);
  saveProvidersFile(providersPath, { providers });
  console.log(`Seeded providers file at ${providersPath} (${providers.map((p) => p.id).join(", ")})`);
}

function ensureCustomers(customersPath: string): void {
  if (existsSync(customersPath)) return;
  const created_at = new Date().toISOString();
  saveProfilesFile(customersPath, {
    customers: SEEDED_CUSTOMERS.map((c) => ({
      customer_id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      created_at,
    })),
  });
  console.log(`Seeded customer profiles at ${customersPath}`);
}

function ensureKeys(keysPath: string): void {
  if (!existsSync(keysPath)) {
    saveRegistryFile(keysPath, { entries: [] });
    console.log(`Created empty key registry at ${keysPath}`);
  }
  // Restore committed hashed seed entries (e.g. the reviewer key) whenever
  // the live registry has no active entry for that customer. Live entries
  // are never overwritten — revocations and rotations always win.
  let seedEntries: Array<{ customer_id: string; key_hash: string; key_hint: string }> = [];
  try {
    const raw = readFileSync(join(process.cwd(), "data/api-keys.seed.json"), "utf8");
    const parsed = JSON.parse(raw) as { entries?: typeof seedEntries };
    if (parsed && Array.isArray(parsed.entries)) seedEntries = parsed.entries;
  } catch {
    // No seed file (e.g. tests) — nothing to restore.
  }
  if (seedEntries.length === 0) {
    loadRegistryFile(keysPath); // validate shape rather than crash
    return;
  }
  const data = loadRegistryFile(keysPath);
  let restored = 0;
  for (const s of seedEntries) {
    if (!s || typeof s.customer_id !== "string" || typeof s.key_hash !== "string") continue;
    // Skip when ANY entry exists for this customer — including revoked ones —
    // so an intentional revocation is never resurrected by a restart.
    // A full filesystem wipe removes all entries, which is when restore fires.
    if (data.entries.some((e) => e.customer_id === s.customer_id)) continue;
    data.entries.push({
      customer_id: s.customer_id,
      key_hash: s.key_hash,
      key_hint: typeof s.key_hint === "string" ? s.key_hint : "",
      revoked: false,
      created_at: new Date().toISOString(),
    });
    restored++;
  }
  if (restored > 0) {
    saveRegistryFile(keysPath, data);
    console.log(`Restored ${restored} seeded API key(s) at ${keysPath}`);
  }
}

/** Mint keys for LUMEN_SEED_KEYS accounts missing one; returns minted {id, key} pairs. */
export function mintSeedKeys(keysPath: string, ids: string[]): Array<{ customer_id: string; rawKey: string }> {
  const minted: Array<{ customer_id: string; rawKey: string }> = [];
  const data = loadRegistryFile(keysPath);
  for (const id of ids) {
    const customer_id = id.trim();
    if (!customer_id) continue;
    // Any existing entry (even revoked) blocks minting, so restarts never
    // resurrect a revoked key. Full wipes remove all entries, then minting fires.
    if (data.entries.some((e) => e.customer_id === customer_id)) continue;
    const rawKey = mintRawKey();
    data.entries.push({
      customer_id,
      key_hash: hashKey(rawKey),
      key_hint: rawKey.slice(0, 12),
      revoked: false,
      created_at: new Date().toISOString(),
    });
    minted.push({ customer_id, rawKey });
  }
  if (minted.length > 0) saveRegistryFile(keysPath, data);
  return minted;
}

export function ensureDataFiles(paths: DataPaths): void {
  ensureProviders(paths.providersPath);
  ensureCustomers(paths.customersPath);
  ensureKeys(paths.keysPath);
  // Re-read provider/customer files so a half-written state can't slip through.
  loadProvidersFile(paths.providersPath);
  loadProfilesFile(paths.customersPath);
  const seedIds = (process.env.LUMEN_SEED_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const { customer_id, rawKey } of mintSeedKeys(paths.keysPath, seedIds)) {
    console.log(`Minted API key for "${customer_id}" (shown ONCE — copy it now, only the hash is stored):`);
    console.log(rawKey);
  }
}

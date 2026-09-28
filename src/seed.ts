// Boot seeding for hosted environments (e.g. Render with a persistent disk).
// Ensures the three file-backed registries exist before the server listens:
// providers (Lumen + spa from the committed seed file), customer profiles
// (seeded sample accounts), and the key registry (empty unless seeded via
// LUMEN_SEED_KEYS). All files are only written when missing, except key
// minting which tops up listed accounts that lack an active key.
// Raw minted keys are printed to stdout ONCE — copy them from the deploy
// logs into the submission materials, then they live only as hashes.

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
  if (existsSync(keysPath)) {
    // Still validate shape; reset corrupt files to empty rather than crash.
    loadRegistryFile(keysPath);
    return;
  }
  saveRegistryFile(keysPath, { entries: [] });
  console.log(`Created empty key registry at ${keysPath}`);
}

/** Mint keys for LUMEN_SEED_KEYS accounts missing one; returns minted {id, key} pairs. */
export function mintSeedKeys(keysPath: string, ids: string[]): Array<{ customer_id: string; rawKey: string }> {
  const minted: Array<{ customer_id: string; rawKey: string }> = [];
  const data = loadRegistryFile(keysPath);
  for (const id of ids) {
    const customer_id = id.trim();
    if (!customer_id) continue;
    if (data.entries.some((e) => e.customer_id === customer_id && !e.revoked)) continue;
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

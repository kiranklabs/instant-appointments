// Customer profiles for the marketplace (Brief B).
// File-backed like every other registry: JSON on disk, re-read per request
// so new signups take effect without a restart. Profiles hold the customer
// record; the keys file links key_hash -> customer_id. Raw keys are never
// stored here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface CustomerProfile {
  customer_id: string;
  name: string;
  phone: string;
  email: string;
  created_at: string;
}

interface ProfilesFile {
  customers: CustomerProfile[];
}

export function loadProfilesFile(filePath: string): ProfilesFile {
  if (!existsSync(filePath)) return { customers: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ProfilesFile;
    if (!parsed || !Array.isArray(parsed.customers)) return { customers: [] };
    return parsed;
  } catch {
    return { customers: [] };
  }
}

export function saveProfilesFile(filePath: string, data: ProfilesFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** File-backed profile lookup (null when unknown). */
export function getProfile(filePath: string, customer_id: string): CustomerProfile | null {
  const found = loadProfilesFile(filePath).customers.find((c) => c.customer_id === customer_id);
  return found ?? null;
}

/** Mint a fresh customer_id for signup (cust_ + 6 hex chars). */
export function mintCustomerId(): string {
  return `cust_${randomBytes(3).toString("hex")}`;
}

export function createProfile(
  filePath: string,
  input: { customer_id?: string; name: string; phone: string; email: string },
): CustomerProfile {
  const data = loadProfilesFile(filePath);
  const customer_id = input.customer_id ?? mintCustomerId();
  if (data.customers.some((c) => c.customer_id === customer_id)) {
    throw new Error(`Customer "${customer_id}" already exists.`);
  }
  const profile: CustomerProfile = {
    customer_id,
    name: input.name,
    phone: input.phone,
    email: input.email,
    created_at: new Date().toISOString(),
  };
  data.customers.push(profile);
  saveProfilesFile(filePath, data);
  return profile;
}

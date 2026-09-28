// Customer identity for bearer keys.
// Layering: this module knows about keys, hashes, and profiles. store.ts
// knows only about customer value objects ({id, name, phone, email}) —
// never raw keys.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getProfile } from "./customers.js";

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
}

/** Seeded sample customers (fictional). Keys are minted via the CLI. */
export const SEEDED_CUSTOMERS: Customer[] = [
  { id: "ava", name: "Ava Chen", phone: "+1 416-555-0101", email: "ava@example.com" },
  { id: "leo", name: "Leo Martin", phone: "+1 416-555-0102", email: "leo@example.com" },
  { id: "mia", name: "Mia Rossi", phone: "+1 416-555-0103", email: "mia@example.com" },
  { id: "meta-reviewer", name: "Meta Reviewer", phone: "+1 416-555-0199", email: "reviewer@example.com" },
];

export function customerById(id: string): Customer | undefined {
  return SEEDED_CUSTOMERS.find((c) => c.id === id);
}

export const KEY_PREFIX = "lumen_";

export function mintRawKey(): string {
  return `${KEY_PREFIX}${randomBytes(16).toString("hex")}`; // lumen_ + 32 hex chars
}

export function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

/** Timing-safe equality for hex hash strings (same length by construction). */
export function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface RegistryEntry {
  customer_id: string;
  key_hash: string;
  /** First chars of the raw key (e.g. lumen_ab12cd) — identifies the key without storing it. */
  key_hint: string;
  revoked: boolean;
  created_at: string;
}

export interface RegistryFile {
  entries: RegistryEntry[];
}

/** Read (or initialize) the registry file. Shared by the server and keys CLI. */
export function loadRegistryFile(filePath: string): RegistryFile {
  if (!existsSync(filePath)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as RegistryFile;
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return parsed;
  } catch {
    return { entries: [] };
  }
}

export function saveRegistryFile(filePath: string, data: RegistryFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * File-backed key registry. Only SHA-256 hashes are stored; raw keys
 * exist solely in CLI mint output. Both files are re-read per request (they
 * are tiny), so revocation and new signups take effect immediately.
 */
export class CustomerRegistry {
  constructor(
    private keysPath: string,
    private customersPath: string,
  ) {}

  /** Resolve a raw bearer key to its customer profile, or null (unknown/revoked). */
  verify(rawKey: string): Customer | null {
    if (typeof rawKey !== "string" || rawKey.length === 0) return null;
    const digest = hashKey(rawKey);
    for (const e of loadRegistryFile(this.keysPath).entries) {
      if (e.revoked) continue;
      if (!hashesEqual(e.key_hash, digest)) continue;
      const customer = this.resolveCustomer(e.customer_id);
      if (customer) return customer;
    }
    return null;
  }

  /**
   * Profile-first identity: the customers file is the source of truth;
   * seeded in-code identities are the bootstrap fallback (used by tests
   * and the sample world before any signup exists).
   */
  resolveCustomer(customer_id: string): Customer | null {
    const profile = getProfile(this.customersPath, customer_id);
    if (profile) {
      return { id: profile.customer_id, name: profile.name, phone: profile.phone, email: profile.email };
    }
    return customerById(customer_id) ?? null;
  }
}

/** Client IP for public-tool rate limiting: first X-Forwarded-For hop, else socket. */
export function clientIp(req: { get(name: string): string | undefined; socket?: { remoteAddress?: string } }): string {
  const forwarded = req.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

export interface RateLimitOptions {
  /** Max requests per window, per key. */
  maxRequests: number;
  /** Window length in ms. */
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  maxRequests: 60,
  windowMs: 60 * 1000,
};

/** Simple in-memory fixed-window per-key rate limiter. */
export class RateLimiter {
  private buckets = new Map<string, { count: number; windowStart: number }>();

  constructor(private opts: RateLimitOptions = DEFAULT_RATE_LIMIT) {}

  check(key: string, now: number = Date.now()): { allowed: boolean; retryAfterSec: number } {
    const b = this.buckets.get(key);
    if (!b || now - b.windowStart >= this.opts.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return { allowed: true, retryAfterSec: 0 };
    }
    if (b.count < this.opts.maxRequests) {
      b.count += 1;
      return { allowed: true, retryAfterSec: 0 };
    }
    const retryAfterSec = Math.max(1, Math.ceil((b.windowStart + this.opts.windowMs - now) / 1000));
    return { allowed: false, retryAfterSec };
  }

  get options(): RateLimitOptions {
    return this.opts;
  }
}

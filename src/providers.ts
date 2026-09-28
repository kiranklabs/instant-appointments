// Provider registry for the open marketplace (Brief A).
// Same file-backed pattern as the key registry: JSON on disk, re-read per
// request so adds/removes/config changes take effect without a restart.
// Per-provider services, staff, hours, and seeds are embedded in each
// provider record (single file, no restart needed).
//
// Timezone note: the sample scheduling engine works in America/Toronto
// wall-clock (see time.ts). Every provider record carries a timezone, but
// the sample adapter only supports America/Toronto for now — the CLI
// rejects anything else with a clear error until a tz-generic engine lands.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SALON, SERVICES, STYLISTS } from "./data.js";

export const SAMPLE_ADAPTER = "sample";
export const SAMPLE_TIMEZONE = "America/Toronto";

export interface ProviderService {
  service_id: string;
  name: string;
  price_cents: number;
  duration_min: number;
  description: string;
}

export interface ProviderStaff {
  name: string;
  /** Subset of service_ids this staff member performs. Order matters: first available wins. */
  services: string[];
}

export interface ProviderHours {
  openHour: number;
  closeHour: number;
  slotStepMin: number;
  /** 0=Sun..6=Sat days the provider is closed. */
  closedWeekdays: number[];
}

export interface ProviderSeed {
  openOffset: number;
  stylist: string;
  service_id: string;
  /** HH:MM wall clock. */
  start: string;
  customer_id: string;
}

export interface ProviderConfig {
  services: ProviderService[];
  staff: ProviderStaff[];
  hours: ProviderHours;
  seeds: ProviderSeed[];
}

export interface Provider {
  id: string;
  name: string;
  category: string;
  location: { city: string; area: string };
  contact: { phone: string; website: string };
  timezone: string;
  adapter: string;
  config: ProviderConfig;
}

export interface ProviderSummary {
  id: string;
  name: string;
  category: string;
  location: { city: string; area: string };
  contact: { phone: string; website: string };
}

export interface ProviderFilter {
  category?: string;
  city?: string;
  query?: string;
}

interface ProvidersFile {
  providers: Provider[];
}

export function loadProvidersFile(filePath: string): ProvidersFile {
  if (!existsSync(filePath)) return { providers: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ProvidersFile;
    if (!parsed || !Array.isArray(parsed.providers)) return { providers: [] };
    return parsed;
  } catch {
    return { providers: [] };
  }
}

export function saveProvidersFile(filePath: string, data: ProvidersFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Validate a provider record. Returns error strings (empty = valid). */
export function validateProvider(p: unknown): string[] {
  const errs: string[] = [];
  if (typeof p !== "object" || p === null) return ["provider must be an object"];
  const r = p as Record<string, unknown>;
  for (const f of ["id", "name", "category", "timezone", "adapter"]) {
    if (typeof r[f] !== "string" || !(r[f] as string).trim()) errs.push(`missing/empty "${f}"`);
  }
  if (typeof r.id === "string" && !/^[a-z0-9][a-z0-9-]*$/.test(r.id)) {
    errs.push(`"id" must be lowercase alphanumeric with dashes`);
  }
  const loc = r.location as Record<string, unknown> | undefined;
  if (!loc || typeof loc.city !== "string" || typeof loc.area !== "string") {
    errs.push(`"location" must be { city, area }`);
  }
  const contact = r.contact as Record<string, unknown> | undefined;
  if (!contact || typeof contact.phone !== "string" || typeof contact.website !== "string") {
    errs.push(`"contact" must be { phone, website }`);
  }
  if (r.adapter !== SAMPLE_ADAPTER) errs.push(`unsupported "adapter" (only "${SAMPLE_ADAPTER}")`);
  if (r.timezone !== SAMPLE_TIMEZONE) {
    errs.push(`unsupported "timezone" (sample adapter supports only "${SAMPLE_TIMEZONE}")`);
  }
  const cfg = r.config as ProviderConfig | undefined;
  if (!cfg || typeof cfg !== "object") {
    errs.push(`missing "config"`);
    return errs;
  }
  if (!Array.isArray(cfg.services) || cfg.services.length === 0) {
    errs.push(`"config.services" must be a non-empty array`);
  } else {
    const ids = new Set<string>();
    for (const s of cfg.services) {
      if (!s.service_id || typeof s.price_cents !== "number" || typeof s.duration_min !== "number") {
        errs.push(`each service needs service_id, price_cents, duration_min`);
        break;
      }
      ids.add(s.service_id);
    }
    if (!Array.isArray(cfg.staff) || cfg.staff.length === 0) {
      errs.push(`"config.staff" must be a non-empty array`);
    } else {
      for (const st of cfg.staff) {
        if (!st.name || !Array.isArray(st.services) || st.services.length === 0) {
          errs.push(`each staff member needs name and non-empty services`);
          break;
        }
        for (const sid of st.services) {
          if (!ids.has(sid)) errs.push(`staff "${st.name}" references unknown service "${sid}"`);
        }
      }
    }
  }
  const h = cfg.hours;
  if (
    !h ||
    typeof h.openHour !== "number" ||
    typeof h.closeHour !== "number" ||
    h.openHour >= h.closeHour ||
    typeof h.slotStepMin !== "number" ||
    h.slotStepMin <= 0 ||
    !Array.isArray(h.closedWeekdays)
  ) {
    errs.push(`"config.hours" must be { openHour, closeHour, slotStepMin, closedWeekdays } with openHour < closeHour`);
  }
  if (!Array.isArray(cfg.seeds)) errs.push(`"config.seeds" must be an array`);
  return errs;
}

export function summarizeProvider(p: Provider): ProviderSummary {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    location: p.location,
    contact: p.contact,
  };
}

/** All filters optional; empty filter lists every provider. */
export function filterProviders(providers: Provider[], filter: ProviderFilter): Provider[] {
  const category = filter.category?.trim().toLowerCase();
  const city = filter.city?.trim().toLowerCase();
  const query = filter.query?.trim().toLowerCase();
  return providers.filter((p) => {
    if (category && p.category.toLowerCase() !== category) return false;
    if (city && p.location.city.toLowerCase() !== city) return false;
    if (query && !`${p.name} ${p.category}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

/** Deterministic fingerprint of a provider's scheduling config (cache sync). */
export function configHash(p: Provider): string {
  return JSON.stringify(p.config);
}

export const LUMEN_PROVIDER_ID = "lumen-hair-studio";

/** Lumen's scheduling config, built from the data.ts sample-world facts. */
export function lumenConfig(): ProviderConfig {
  return {
    services: SERVICES.map((s) => ({ ...s })),
    staff: STYLISTS.map((s) => ({ name: s.name, services: [...s.services] })),
    hours: {
      openHour: SALON.openHour,
      closeHour: SALON.closeHour,
      slotStepMin: SALON.slotStepMin,
      closedWeekdays: [...SALON.closedWeekdays],
    },
    seeds: [
      { openOffset: 0, stylist: "Maya", service_id: "haircut", start: "10:00", customer_id: "ava" },
      { openOffset: 0, stylist: "Maya", service_id: "haircut", start: "11:00", customer_id: "ava" },
      { openOffset: 0, stylist: "Jordan", service_id: "blowout", start: "09:30", customer_id: "leo" },
      { openOffset: 1, stylist: "Priya", service_id: "color", start: "09:00", customer_id: "leo" },
      { openOffset: 1, stylist: "Maya", service_id: "color", start: "13:00", customer_id: "mia" },
      { openOffset: 2, stylist: "Jordan", service_id: "haircut", start: "14:00", customer_id: "mia" },
    ],
  };
}

/** Full Lumen provider record (registry entry + embedded config). */
export function lumenProvider(): Provider {
  return {
    id: LUMEN_PROVIDER_ID,
    name: "Lumen Hair Studio",
    category: "salon",
    location: { city: "Toronto", area: "Downtown" },
    contact: { phone: "+1 416-555-0101", website: "https://example.com" },
    timezone: SAMPLE_TIMEZONE,
    adapter: SAMPLE_ADAPTER,
    config: lumenConfig(),
  };
}

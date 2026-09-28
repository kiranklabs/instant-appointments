// Fixed sample world facts for Lumen Hair Studio v1.
// Treat these as fixed: one fictional Toronto location, 3 services,
// 3 stylists working Tue-Sat 09:00-18:00, each performing a subset.

export interface Service {
  service_id: string;
  name: string;
  price_cents: number;
  duration_min: number;
  description: string;
}

export const SERVICES: Service[] = [
  {
    service_id: "haircut",
    name: "Haircut",
    price_cents: 4500,
    duration_min: 45,
    description:
      "Consultation, precision cut, wash and style finish with Maya or Jordan.",
  },
  {
    service_id: "color",
    name: "Full Color",
    price_cents: 12000,
    duration_min: 120,
    description:
      "Full all-over color with gloss seal and style finish with Maya or Priya.",
  },
  {
    service_id: "blowout",
    name: "Blowout",
    price_cents: 3500,
    duration_min: 30,
    description:
      "Wash, blow-dry and styled finish with Jordan or Priya.",
  },
];

export interface Stylist {
  name: string;
  /** Subset of service_ids this stylist performs. Order matters: first available wins. */
  services: string[];
}

export const STYLISTS: Stylist[] = [
  { name: "Maya", services: ["haircut", "color"] },
  { name: "Jordan", services: ["haircut", "blowout"] },
  { name: "Priya", services: ["color", "blowout"] },
];

export const SALON = {
  name: "Lumen Hair Studio",
  location: "Toronto",
  timezone: "America/Toronto",
  // 0=Sun..6=Sat. Closed Sun (0) and Mon (1); open Tue-Sat.
  closedWeekdays: [0, 1] as readonly number[],
  openHour: 9,
  closeHour: 18,
  slotStepMin: 15,
} as const;

export const QUOTE_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const PRICE_VALIDITY_DAYS = 30; // list_services price guarantee window
export const PRICE_CURRENCY = "CAD";
export const MAX_ALTERNATIVE_DAYS = 3;
export const ALTERNATIVE_SEARCH_RADIUS_DAYS = 7;

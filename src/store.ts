// Single in-memory store: availability and booking read/write the same
// Maps, so double-booking is impossible by construction (every mutation
// goes through an atomic overlap check against active bookings +
// unexpired quotes for the same stylist).

import {
  ALTERNATIVE_SEARCH_RADIUS_DAYS,
  MAX_ALTERNATIVE_DAYS,
  PRICE_CURRENCY,
  PRICE_VALIDITY_DAYS,
  QUOTE_TTL_MS,
} from "./data.js";
import {
  addDays,
  hhmmToMinutes,
  isValidDateStr,
  isValidTimeStr,
  plusMsISO,
  nextOpenDateStr,
  torontoISO,
  torontoToday,
  torontoWeekday,
} from "./time.js";
import { randomUUID } from "node:crypto";
import { customerById, type Customer } from "./auth.js";
import {
  lumenProvider,
  type Provider,
  type ProviderSeed,
  type ProviderService,
  type ProviderStaff,
} from "./providers.js";

export interface Slot {
  slot_id: string;
  service_id: string;
  starts_at: string;
  ends_at: string;
  stylist: string;
  price_cents: number;
  price_currency: string;
  /** ISO timestamp until which this price is guaranteed (quote window). */
  price_valid_until: string;
}

export interface ServiceOut {
  service_id: string;
  name: string;
  price_cents: number;
  price_currency: string;
  price_valid_until: string;
  duration_min: number;
  description: string;
}

export interface Quote {
  quote_id: string;
  /** Owner: customer id resolved from the bearer key at quote time. */
  customer_id: string;
  service_id: string;
  service: string;
  slot_id: string;
  starts_at: string;
  ends_at: string;
  stylist: string;
  price_cents: number;
  price_currency: string;
  /** Price guarantee == quote validity. */
  price_valid_until: string;
  valid_until: string;
}

export interface Booking {
  booking_id: string;
  quote_id: string;
  /** Owner: customer id resolved from the bearer key at booking time. */
  customer_id: string;
  service_id: string;
  service: string;
  starts_at: string;
  ends_at: string;
  stylist: string;
  price_cents: number;
  price_currency: string;
  price_valid_until: string;
  customer_name: string;
  customer_contact: string;
  /** Provider CRM record: pushed to the provider's system at booking time. */
  customer_snapshot: { name: string; phone: string };
  status: "active" | "cancelled" | "rescheduled";
}

export interface AvailabilityDay {
  date: string;
  slots: Slot[];
}

export interface AvailabilityResult {
  date: string;
  closed: boolean;
  slots: Slot[];
  alternatives: AvailabilityDay[];
  message: string;
  price_currency: string;
}

export interface ErrorResult {
  ok: false;
  error: { code: string; message: string };
  fresh_availability?: AvailabilityResult;
  valid_services?: string[];
}

const WEEKDAY_PLURAL = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

/** "Sundays and Mondays" / "Mondays" — for closed-day messages. */
function closedDayNames(closedWeekdays: readonly number[]): string {
  const picked = [...closedWeekdays].sort((a, b) => a - b).map((d) => WEEKDAY_PLURAL[d]);
  if (picked.length <= 1) return picked[0] ?? "closed days";
  if (picked.length === 2) return `${picked[0]} and ${picked[1]}`;
  return `${picked.slice(0, -1).join(", ")}, and ${picked[picked.length - 1]}`;
}

/** slot_id = stylist|starts_at|service_id (ISO contains no '|', safe to split). */
export function encodeSlotId(stylist: string, starts_at: string, service_id: string): string {
  return `${stylist}|${starts_at}|${service_id}`;
}

export function decodeSlotId(slot_id: string): {
  stylist: string;
  starts_at: string;
  service_id: string;
} | null {
  const parts = slot_id.split("|");
  if (parts.length !== 3) return null;
  const [stylist, starts_at, service_id] = parts;
  if (!stylist || !starts_at || !service_id) return null;
  if (Number.isNaN(Date.parse(starts_at))) return null;
  return { stylist, starts_at, service_id };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export class SalonStore {
  private bookings = new Map<string, Booking>();
  private quotes = new Map<string, Quote>();
  /** quote_id -> booking_id for idempotent book_appointment. */
  private bookingByQuote = new Map<string, string>();
  private quoteTtlMs: number;
  // ---- provider-namespaced scheduling config (Brief A) ----
  private providerId: string;
  private providerName: string;
  private services: ProviderService[];
  private staff: ProviderStaff[];
  private closedWeekdays: number[];
  private openHour: number;
  private closeHour: number;
  private slotStepMin: number;
  private seedDefs: ProviderSeed[];

  /**
   * Bare `new SalonStore()` keeps the Lumen sample world (existing tests).
   * Multi-provider servers construct one store per provider record and call
   * updateConfig() on registry re-reads (bookings/quotes are preserved).
   */
  constructor(provider: Provider = lumenProvider(), quoteTtlMs: number = QUOTE_TTL_MS) {
    this.quoteTtlMs = quoteTtlMs;
    this.providerId = provider.id;
    this.providerName = provider.name;
    this.services = [];
    this.staff = [];
    this.closedWeekdays = [];
    this.openHour = 9;
    this.closeHour = 18;
    this.slotStepMin = 15;
    this.seedDefs = [];
    this.applyConfig(provider);
    this.seed();
  }

  /** Refresh scheduling config without touching bookings/quotes (hot reload). */
  updateConfig(provider: Provider): void {
    this.applyConfig(provider);
  }

  private applyConfig(provider: Provider): void {
    this.providerId = provider.id;
    this.providerName = provider.name;
    this.services = provider.config.services;
    this.staff = provider.config.staff;
    this.closedWeekdays = [...provider.config.hours.closedWeekdays];
    this.openHour = provider.config.hours.openHour;
    this.closeHour = provider.config.hours.closeHour;
    this.slotStepMin = provider.config.hours.slotStepMin;
    this.seedDefs = provider.config.seeds;
  }

  getProviderId(): string {
    return this.providerId;
  }

  private serviceById(id: string): ProviderService | undefined {
    return this.services.find((s) => s.service_id === id);
  }

  private stylistByName(name: string): ProviderStaff | undefined {
    return this.staff.find((s) => s.name === name);
  }

  // ---------- test helpers ----------
  reset(): void {
    this.bookings.clear();
    this.quotes.clear();
    this.bookingByQuote.clear();
    this.seed();
  }

  /** Simulate expiry without waiting 15 minutes (tests + demos). */
  forceExpireQuote(quote_id: string): boolean {
    const q = this.quotes.get(quote_id);
    if (!q) return false;
    q.valid_until = new Date(Date.now() - 1000).toISOString();
    q.price_valid_until = q.valid_until;
    return true;
  }

  getActiveBookings(): Booking[] {
    return [...this.bookings.values()].filter((b) => b.status === "active");
  }

  getQuote(quote_id: string): Quote | undefined {
    return this.quotes.get(quote_id);
  }

  getBooking(booking_id: string): Booking | undefined {
    return this.bookings.get(booking_id);
  }

  // ---------- seeds ----------
  private seed(): void {
    // A handful of pre-existing bookings on near-term open days so
    // "no availability" paths are testable and days look realistic.
    const today = torontoToday();
    this.seedDefs.forEach((s, i) => {
      const date = nextOpenDateStr(today, s.openOffset, this.closedWeekdays);
      const svc = this.serviceById(s.service_id);
      const owner = s.customer_id ? customerById(s.customer_id) : undefined;
      const st = this.stylistByName(s.stylist);
      // Defensive: skip seed rows that don't fit this provider's config
      // (the providers CLI validates seeds on add; this is belt-and-braces).
      if (!svc || !owner || !st || !st.services.includes(svc.service_id)) return;
      const startMin = hhmmToMinutes(s.start);
      const starts_at = torontoISO(date, startMin);
      const ends_at = torontoISO(date, startMin + svc.duration_min);
      const quote_id = `seed-quote-${i + 1}`;
      const booking_id = `seed-booking-${i + 1}`;
      const valid_until = plusMsISO(this.quoteTtlMs);
      this.quotes.set(quote_id, {
        quote_id,
        customer_id: owner.id,
        service_id: svc.service_id,
        service: svc.name,
        slot_id: encodeSlotId(s.stylist, starts_at, svc.service_id),
        starts_at,
        ends_at,
        stylist: s.stylist,
        price_cents: svc.price_cents,
        price_currency: PRICE_CURRENCY,
        price_valid_until: valid_until,
        valid_until,
      });
      this.bookings.set(booking_id, {
        booking_id,
        quote_id,
        customer_id: owner.id,
        service_id: svc.service_id,
        service: svc.name,
        starts_at,
        ends_at,
        stylist: s.stylist,
        price_cents: svc.price_cents,
        price_currency: PRICE_CURRENCY,
        price_valid_until: valid_until,
        customer_name: owner.name,
        customer_contact: owner.email,
        customer_snapshot: { name: owner.name, phone: owner.phone },
        status: "active",
      });
      this.bookingByQuote.set(quote_id, booking_id);
    });
  }

  private quoteLive(q: Quote, now: number = Date.now()): boolean {
    return Date.parse(q.valid_until) > now;
  }

  /** All busy intervals (ms) for a stylist: active bookings + unexpired quotes. */
  private busyIntervals(
    stylist: string,
    excludeBookingId?: string,
    excludeQuoteId?: string,
    now: number = Date.now(),
  ): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const b of this.bookings.values()) {
      if (b.status !== "active" || b.stylist !== stylist) continue;
      if (excludeBookingId && b.booking_id === excludeBookingId) continue;
      out.push([Date.parse(b.starts_at), Date.parse(b.ends_at)]);
    }
    for (const q of this.quotes.values()) {
      if (q.stylist !== stylist) continue;
      if (excludeQuoteId && q.quote_id === excludeQuoteId) continue;
      if (!this.quoteLive(q, now)) continue;
      // A consumed quote's interval is already covered by its booking; skip
      // it so reschedule/cancel accounting stays single-sourced.
      if (this.bookingByQuote.has(q.quote_id)) continue;
      out.push([Date.parse(q.starts_at), Date.parse(q.ends_at)]);
    }
    return out;
  }

  private isFree(
    stylist: string,
    startMs: number,
    endMs: number,
    excludeBookingId?: string,
    now: number = Date.now(),
    excludeQuoteId?: string,
  ): boolean {
    return !this.busyIntervals(stylist, excludeBookingId, excludeQuoteId, now).some(([s, e]) =>
      overlaps(startMs, endMs, s, e),
    );
  }

  // ---------- tool 1: list_services ----------
  listServices(): { services: ServiceOut[] } {
    const price_valid_until = plusMsISO(PRICE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
    return {
      services: this.services.map((s) => ({
        service_id: s.service_id,
        name: s.name,
        price_cents: s.price_cents,
        price_currency: PRICE_CURRENCY,
        price_valid_until,
        duration_min: s.duration_min,
        description: s.description,
      })),
    };
  }

  // ---------- tool 2: check_availability ----------
  checkAvailability(
    service_id: string,
    date: string,
    preferred_time?: string,
  ): AvailabilityResult | ErrorResult {
    const svc = this.serviceById(service_id);
    if (!svc) {
      return {
        ok: false,
        error: {
          code: "UNKNOWN_SERVICE",
          message: `Unknown service_id "${service_id}".`,
        },
        valid_services: this.services.map((s) => s.service_id),
      };
    }
    if (!isValidDateStr(date)) {
      return {
        ok: false,
        error: {
          code: "INVALID_DATE",
          message: `Invalid date "${date}". Use YYYY-MM-DD.`,
        },
      };
    }
    if (preferred_time !== undefined && !isValidTimeStr(preferred_time)) {
      return {
        ok: false,
        error: {
          code: "INVALID_TIME",
          message: `Invalid preferred_time "${preferred_time}". Use HH:MM (24h).`,
        },
      };
    }

    const closed = this.closedWeekdays.includes(torontoWeekday(date));
    if (closed) {
      return {
        date,
        closed: true,
        slots: [],
        alternatives: this.findAlternatives(service_id, date),
        message: `${this.providerName} is closed on ${closedDayNames(this.closedWeekdays)}. Nearest open days with ${svc.name} availability are listed under alternatives.`,
        price_currency: PRICE_CURRENCY,
      };
    }

    let slots = this.daySlots(service_id, date);
    if (preferred_time) {
      const pref = hhmmToMinutes(preferred_time);
      slots = [...slots].sort((a, b) => {
        const da = Math.abs(Date.parse(a.starts_at) - Date.parse(torontoISO(date, pref)));
        const db = Math.abs(Date.parse(b.starts_at) - Date.parse(torontoISO(date, pref)));
        return da - db;
      });
    }

    if (slots.length === 0) {
      return {
        date,
        closed: false,
        slots: [],
        alternatives: this.findAlternatives(service_id, date),
        message: `No ${svc.name} slots on ${date}. Nearest alternatives (same service, adjacent days) are listed under alternatives.`,
        price_currency: PRICE_CURRENCY,
      };
    }
    return {
      date,
      closed: false,
      slots,
      alternatives: [],
      message: `${slots.length} ${svc.name} slot(s) on ${date}. Prices guaranteed for 15 minutes once quoted.`,
      price_currency: PRICE_CURRENCY,
    };
  }

  /** All bookable slots for a service on an open date, chronological. */
  private daySlots(
    service_id: string,
    date: string,
    now: number = Date.now(),
    excludeBookingId?: string,
  ): Slot[] {
    const svc = this.serviceById(service_id);
    if (!svc) return [];
    if (this.closedWeekdays.includes(torontoWeekday(date))) return [];
    const price_valid_until = plusMsISO(this.quoteTtlMs, now);
    const out: Slot[] = [];
    const lastStart = this.closeHour * 60 - svc.duration_min;
    for (let start = this.openHour * 60; start <= lastStart; start += this.slotStepMin) {
      const starts_at = torontoISO(date, start);
      const ends_at = torontoISO(date, start + svc.duration_min);
      const startMs = Date.parse(starts_at);
      const endMs = Date.parse(ends_at);
      // First available stylist wins; customer does not pick.
      for (const st of this.staff) {
        if (!st.services.includes(service_id)) continue;
        if (!this.isFree(st.name, startMs, endMs, excludeBookingId, now)) continue;
        out.push({
          slot_id: encodeSlotId(st.name, starts_at, service_id),
          service_id,
          starts_at,
          ends_at,
          stylist: st.name,
          price_cents: svc.price_cents,
          price_currency: PRICE_CURRENCY,
          price_valid_until,
        });
        break;
      }
    }
    return out;
  }

  private findAlternatives(service_id: string, date: string): AvailabilityDay[] {
    const days: AvailabilityDay[] = [];
    for (let k = 1; k <= ALTERNATIVE_SEARCH_RADIUS_DAYS && days.length < MAX_ALTERNATIVE_DAYS; k++) {
      for (const cand of [addDays(date, k), addDays(date, -k)]) {
        if (days.length >= MAX_ALTERNATIVE_DAYS) break;
        if (this.closedWeekdays.includes(torontoWeekday(cand))) continue;
        if (Date.parse(`${cand}T00:00:00Z`) < Date.parse(`${torontoToday()}T00:00:00Z`)) continue;
        const slots = this.daySlots(service_id, cand);
        if (slots.length > 0) days.push({ date: cand, slots });
      }
    }
    // Nearest-first by absolute distance, future preferred on ties.
    return days.sort((a, b) => {
      const da = Math.abs(Date.parse(a.date) - Date.parse(date));
      const db = Math.abs(Date.parse(b.date) - Date.parse(date));
      return da - db || (a.date < b.date ? -1 : 1);
    });
  }

  // ---------- tool 3: create_quote ----------
  createQuote(slot_id: string, customer: Customer): Quote | ErrorResult {
    const decoded = decodeSlotId(slot_id);
    if (!decoded) {
      return {
        ok: false,
        error: {
          code: "INVALID_SLOT",
          message: `Invalid slot_id. Pick one from check_availability.`,
        },
      };
    }
    const { stylist, starts_at, service_id } = decoded;
    const svc = this.serviceById(service_id);
    const st = this.stylistByName(stylist);
    if (!svc || !st || !st.services.includes(service_id)) {
      return {
        ok: false,
        error: {
          code: "INVALID_SLOT",
          message: `Slot references an unknown stylist/service combination.`,
        },
        fresh_availability: this.safeAvailability(service_id, starts_at),
      };
    }
    const datePart = starts_at.slice(0, 10);
    if (!isValidDateStr(datePart)) {
      return {
        ok: false,
        error: { code: "INVALID_SLOT", message: `Invalid slot_id. Pick one from check_availability.` },
      };
    }
    // Single-sourced validity: the slot must be exactly one the generator
    // offers right now (open day, 15-min grid, fits in 09:00-18:00, stylist
    // performs the service, overlaps no booking or live quote). This also
    // rejects forged slot_ids with mismatched offsets.
    const live = this.daySlots(service_id, datePart).find((s) => s.slot_id === slot_id);
    if (!live) {
      return {
        ok: false,
        error: {
          code: "SLOT_UNAVAILABLE",
          message: `That slot is not currently bookable (taken, locked by a quote, outside hours, or invalid). Fresh availability is included below.`,
        },
        fresh_availability: this.safeAvailability(service_id, datePart),
      };
    }
    const quote_id = randomUUID();
    const valid_until = plusMsISO(this.quoteTtlMs);
    const quote: Quote = {
      quote_id,
      customer_id: customer.id,
      service_id: svc.service_id,
      service: svc.name,
      slot_id: live.slot_id,
      starts_at: live.starts_at,
      ends_at: live.ends_at,
      stylist: live.stylist,
      price_cents: svc.price_cents,
      price_currency: PRICE_CURRENCY,
      price_valid_until: valid_until,
      valid_until,
    };
    this.quotes.set(quote_id, quote);
    return quote;
  }

  private safeAvailability(service_id: string, starts_at_or_date: string): AvailabilityResult {
    const date = starts_at_or_date.slice(0, 10);
    const res = this.checkAvailability(service_id, isValidDateStr(date) ? date : torontoToday());
    if ("ok" in res) {
      // Fallback: should not happen for valid service/date; return empty shape.
      return {
        date: torontoToday(),
        closed: false,
        slots: [],
        alternatives: [],
        message: "Availability temporarily unavailable.",
        price_currency: PRICE_CURRENCY,
      };
    }
    return res;
  }

  // ---------- tool 4: book_appointment (idempotent on quote_id) ----------
  // Identity comes only from the authenticated customer. There is no
  // caller-supplied customer field to forge.
  bookAppointment(quote_id: string, customer: Customer): Booking | ErrorResult {
    // Idempotency: same quote booked twice under the same key -> identical
    // confirmation, one booking. A different customer's quote_id is
    // indistinguishable from an unknown one (no existence oracle).
    const existingId = this.bookingByQuote.get(quote_id);
    if (existingId) {
      const existing = this.bookings.get(existingId);
      if (existing && existing.customer_id === customer.id) return { ...existing };
      return {
        ok: false,
        error: { code: "UNKNOWN_QUOTE", message: `No quote found for quote_id "${quote_id}". Quotes expire after 15 minutes.` },
      };
    }
    const q = this.quotes.get(quote_id);
    if (!q || q.customer_id !== customer.id) {
      return {
        ok: false,
        error: { code: "UNKNOWN_QUOTE", message: `No quote found for quote_id "${quote_id}". Quotes expire after 15 minutes.` },
      };
    }
    if (!this.quoteLive(q)) {
      return {
        ok: false,
        error: {
          code: "QUOTE_EXPIRED",
          message: `Quote ${quote_id} expired at ${q.valid_until}. It was valid for 15 minutes. Fresh availability for the same service is included below — pick a new slot and quote again.`,
        },
        fresh_availability: this.safeAvailability(q.service_id, q.starts_at),
      };
    }
    // Defensive re-check: verify no overlapping active booking (same store,
    // same check). The quote being consumed is excluded so it can't block
    // its own slot.
    const startMs = Date.parse(q.starts_at);
    const endMs = Date.parse(q.ends_at);
    if (!this.isFree(q.stylist, startMs, endMs, undefined, Date.now(), q.quote_id)) {
      return {
        ok: false,
        error: {
          code: "SLOT_UNAVAILABLE",
          message: `The quoted slot is no longer free. Fresh availability is included below.`,
        },
        fresh_availability: this.safeAvailability(q.service_id, q.starts_at),
      };
    }
    const booking: Booking = {
      booking_id: randomUUID(),
      quote_id,
      customer_id: customer.id,
      service_id: q.service_id,
      service: q.service,
      starts_at: q.starts_at,
      ends_at: q.ends_at,
      stylist: q.stylist,
      price_cents: q.price_cents,
      price_currency: q.price_currency,
      price_valid_until: q.price_valid_until,
      customer_name: customer.name,
      customer_contact: customer.email,
      customer_snapshot: { name: customer.name, phone: customer.phone },
      status: "active",
    };
    this.bookings.set(booking.booking_id, booking);
    this.bookingByQuote.set(quote_id, booking.booking_id);
    return { ...booking };
  }

  // ---------- tool 5: reschedule ----------
  rescheduleAppointment(
    booking_id: string,
    new_slot_id: string,
    customer: Customer,
  ): (Booking & { rescheduled_from: { starts_at: string; ends_at: string; stylist: string } }) | ErrorResult {
    const booking = this.bookings.get(booking_id);
    // Uniform not-found: another customer's booking is indistinguishable
    // from a nonexistent one.
    if (!booking || booking.status !== "active" || booking.customer_id !== customer.id) {
      return {
        ok: false,
        error: {
          code: "UNKNOWN_BOOKING",
          message: `No active booking found for booking_id "${booking_id}".`,
        },
      };
    }
    const decoded = decodeSlotId(new_slot_id);
    if (!decoded) {
      return {
        ok: false,
        error: { code: "INVALID_SLOT", message: `Invalid new_slot_id. Pick one from check_availability.` },
        fresh_availability: this.safeAvailability(booking.service_id, booking.starts_at),
      };
    }
    if (decoded.service_id !== booking.service_id) {
      return {
        ok: false,
        error: {
          code: "SERVICE_MISMATCH",
          message: `Reschedule keeps the same service (${booking.service_id}). To change service, cancel and book fresh.`,
        },
        fresh_availability: this.safeAvailability(booking.service_id, decoded.starts_at),
      };
    }
    const st = this.stylistByName(decoded.stylist);
    if (!st || !st.services.includes(booking.service_id)) {
      return {
        ok: false,
        error: { code: "INVALID_SLOT", message: `Unknown stylist/service combination.` },
        fresh_availability: this.safeAvailability(booking.service_id, decoded.starts_at),
      };
    }
    const datePart = decoded.starts_at.slice(0, 10);
    if (!isValidDateStr(datePart)) {
      return {
        ok: false,
        error: { code: "INVALID_SLOT", message: `Invalid new_slot_id. Pick one from check_availability.` },
        fresh_availability: this.safeAvailability(booking.service_id, booking.starts_at),
      };
    }
    const currentSlotId = encodeSlotId(booking.stylist, booking.starts_at, booking.service_id);
    const from = { starts_at: booking.starts_at, ends_at: booking.ends_at, stylist: booking.stylist };
    if (new_slot_id === currentSlotId) {
      // No-op move: same slot, return the confirmation unchanged.
      return { ...booking, rescheduled_from: from };
    }
    // Single-sourced validity, excluding the booking being moved so its own
    // slot doesn't block the check (allows moves that overlap the old slot).
    const live = this.daySlots(booking.service_id, datePart, Date.now(), booking.booking_id).find(
      (s) => s.slot_id === new_slot_id,
    );
    if (!live) {
      return {
        ok: false,
        error: { code: "SLOT_UNAVAILABLE", message: `The new slot is not free or not valid. Alternatives included below.` },
        fresh_availability: this.safeAvailability(booking.service_id, decoded.starts_at),
      };
    }
    booking.starts_at = live.starts_at;
    booking.ends_at = live.ends_at;
    booking.stylist = live.stylist;
    return { ...booking, rescheduled_from: from };
  }

  // ---------- tool 6: cancel ----------
  cancelAppointment(
    booking_id: string,
    customer: Customer,
  ): {
    cancelled: boolean;
    booking_id: string;
    service: string;
    freed_slot_id: string;
    freed_starts_at: string;
    freed_ends_at: string;
    stylist: string;
    price_cents: number;
    price_currency: string;
    price_valid_until: string;
    message: string;
    } | ErrorResult {
    const booking = this.bookings.get(booking_id);
    // Uniform not-found: another customer's booking is indistinguishable
    // from a nonexistent one.
    if (!booking || booking.customer_id !== customer.id) {
      return {
        ok: false,
        error: { code: "UNKNOWN_BOOKING", message: `No booking found for booking_id "${booking_id}".` },
      };
    }
    if (booking.status === "cancelled") {
      return {
        cancelled: true,
        booking_id: booking.booking_id,
        service: booking.service,
        freed_slot_id: encodeSlotId(booking.stylist, booking.starts_at, booking.service_id),
        freed_starts_at: booking.starts_at,
        freed_ends_at: booking.ends_at,
        stylist: booking.stylist,
        price_cents: booking.price_cents,
        price_currency: booking.price_currency,
        price_valid_until: booking.price_valid_until,
        message: `Booking ${booking_id} was already cancelled. No duplicate cancellation created.`,
      };
    }
    booking.status = "cancelled";
    return {
      cancelled: true,
      booking_id: booking.booking_id,
      service: booking.service,
      freed_slot_id: encodeSlotId(booking.stylist, booking.starts_at, booking.service_id),
      freed_starts_at: booking.starts_at,
      freed_ends_at: booking.ends_at,
      stylist: booking.stylist,
      price_cents: booking.price_cents,
      price_currency: booking.price_currency,
      price_valid_until: booking.price_valid_until,
      message: `Booking ${booking_id} cancelled. The slot is bookable again.`,
    };
  }
}

export const defaultStore = new SalonStore();

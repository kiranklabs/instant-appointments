// Acceptance + awkward-case tests (T1-T6) for Lumen Hair Studio.
// Identity comes from the authenticated bearer key: store-level tests pass
// customer value objects directly (HTTP auth is covered in auth-security).
// Run: npm test
import { describe, expect, it } from "vitest";
import { customerById, type Customer } from "../src/auth";
import { SALON, SERVICES } from "../src/data";
import { SalonStore, decodeSlotId } from "../src/store";
import { addDays, torontoToday, torontoWeekday } from "../src/time";
import { nextOpenDateStr } from "../src/time";

const AVA: Customer = customerById("ava")!;
const LEO: Customer = customerById("leo")!;

function freshStore() {
  return new SalonStore();
}

/** Open date far enough out that seed bookings never interfere. */
function openDate(offsetOpenDays = 5): string {
  return nextOpenDateStr(torontoToday(), offsetOpenDays, SALON.closedWeekdays);
}

function nextSunday(): string {
  let d = addDays(torontoToday(), 1);
  for (let i = 0; i < 14; i++) {
    if (torontoWeekday(d) === 0) return d;
    d = addDays(d, 1);
  }
  throw new Error("no Sunday found");
}

function mustAvail(store: SalonStore, service: string, date: string) {
  const res = store.checkAvailability(service, date);
  if ("ok" in res) throw new Error(`availability error: ${JSON.stringify(res)}`);
  return res;
}

function mustQuote(store: SalonStore, slot_id: string, customer: Customer = AVA) {
  const q = store.createQuote(slot_id, customer);
  if ("ok" in q) throw new Error(`quote error: ${JSON.stringify(q)}`);
  return q;
}

function mustBook(store: SalonStore, quote_id: string, customer: Customer = AVA) {
  const b = store.bookAppointment(quote_id, customer);
  if ("ok" in b) throw new Error(`book error: ${JSON.stringify(b)}`);
  return b;
}

describe("acceptance: list_services", () => {
  it("returns the three services with correct prices and durations", () => {
    const { services } = freshStore().listServices();
    expect(services).toHaveLength(3);
    const byId = Object.fromEntries(services.map((s) => [s.service_id, s]));
    expect(byId.haircut.price_cents).toBe(4500);
    expect(byId.haircut.duration_min).toBe(45);
    expect(byId.color.price_cents).toBe(12000);
    expect(byId.color.duration_min).toBe(120);
    expect(byId.blowout.price_cents).toBe(3500);
    expect(byId.blowout.duration_min).toBe(30);
  });

  it("every service price carries a validity window", () => {
    for (const s of freshStore().listServices().services) {
      expect(s.price_currency).toBe("CAD");
      expect(Date.parse(s.price_valid_until)).toBeGreaterThan(Date.now());
    }
  });
});

describe("acceptance: check_availability grid + overlap", () => {
  it("slots are 15-min grid, fit in 09:00-18:00, avoid seeded bookings", () => {
    const store = freshStore();
    for (const svc of SERVICES) {
      const date = openDate();
      const res = mustAvail(store, svc.service_id, date);
      expect(res.closed).toBe(false);
      expect(res.slots.length).toBeGreaterThan(0);
      for (const slot of res.slots) {
        const m = /T(\d{2}):(\d{2})/.exec(slot.starts_at)!;
        const startMin = Number(m[1]) * 60 + Number(m[2]);
        expect(startMin % 15).toBe(0);
        expect(startMin).toBeGreaterThanOrEqual(9 * 60);
        expect(Date.parse(slot.ends_at) - Date.parse(slot.starts_at)).toBe(
          svc.duration_min * 60 * 1000,
        );
        expect(Date.parse(slot.ends_at)).toBeLessThanOrEqual(
          Date.parse(`${date}T18:00:00${slot.starts_at.slice(-6)}`),
        );
        expect(slot.price_cents).toBe(svc.price_cents);
        expect(Date.parse(slot.price_valid_until)).toBeGreaterThan(Date.now());
        expect(decodeSlotId(slot.slot_id)).not.toBeNull();
      }
      // No slot overlaps an active booking for the same stylist.
      for (const b of store.getActiveBookings()) {
        for (const slot of res.slots) {
          if (slot.stylist !== b.stylist) continue;
          const over =
            Date.parse(slot.starts_at) < Date.parse(b.ends_at) &&
            Date.parse(b.starts_at) < Date.parse(slot.ends_at);
          expect(over).toBe(false);
        }
      }
    }
  });
});

describe("T6: slot lock contention", () => {
  it("quoted slot is hidden from availability until the quote expires", () => {
    const store = freshStore();
    const date = openDate();
    const before = mustAvail(store, "haircut", date);
    const target = before.slots[0];
    const quote = mustQuote(store, target.slot_id);
    expect(quote.slot_id).toBe(target.slot_id);
    const during = mustAvail(store, "haircut", date);
    expect(during.slots.map((s) => s.slot_id)).not.toContain(target.slot_id);
    // After expiry the slot is offered again.
    store.forceExpireQuote(quote.quote_id);
    const after = mustAvail(store, "haircut", date);
    expect(after.slots.map((s) => s.slot_id)).toContain(target.slot_id);
  });

  it("quoting an already-quoted slot fails with fresh availability", () => {
    const store = freshStore();
    const date = openDate();
    const slot = mustAvail(store, "blowout", date).slots[0];
    mustQuote(store, slot.slot_id);
    const second = store.createQuote(slot.slot_id, AVA);
    expect("ok" in second && second.ok === false).toBe(true);
    if ("ok" in second) {
      expect(second.error.code).toBe("SLOT_UNAVAILABLE");
      expect(second.fresh_availability).toBeDefined();
    }
  });
});

describe("T2: double book request", () => {
  it("same quote booked twice -> byte-identical confirmations, one booking", () => {
    const store = freshStore();
    const date = openDate();
    const slot = mustAvail(store, "haircut", date).slots[0];
    const quote = mustQuote(store, slot.slot_id);
    const first = mustBook(store, quote.quote_id);
    const second = store.bookAppointment(quote.quote_id, AVA);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const forQuote = store.getActiveBookings().filter((b) => b.quote_id === quote.quote_id);
    expect(forQuote).toHaveLength(1);
  });
});

describe("T1: expired quote booking", () => {
  it("fails cleanly with error + fresh availability", () => {
    const store = freshStore();
    const date = openDate();
    const slot = mustAvail(store, "color", date).slots[0];
    const quote = mustQuote(store, slot.slot_id);
    store.forceExpireQuote(quote.quote_id);
    const res = store.bookAppointment(quote.quote_id, AVA);
    expect("ok" in res && res.ok === false).toBe(true);
    if ("ok" in res) {
      expect(res.error.code).toBe("QUOTE_EXPIRED");
      expect(res.error.message).toMatch(/expir/i);
      expect(res.fresh_availability).toBeDefined();
      expect(res.fresh_availability!.slots.length).toBeGreaterThan(0);
    }
  });
});

describe("T3: reschedule to another day", () => {
  it("moves booking, frees old slot", () => {
    const store = freshStore();
    const dayA = openDate(5);
    const dayB = openDate(6);
    const slotA = mustAvail(store, "blowout", dayA).slots[0];
    const booking = mustBook(store, mustQuote(store, slotA.slot_id).quote_id);
    const slotB = mustAvail(store, "blowout", dayB).slots.find(
      (s) => s.slot_id !== slotA.slot_id,
    )!;
    const moved = store.rescheduleAppointment(booking.booking_id, slotB.slot_id, AVA);
    if ("ok" in moved) throw new Error(`reschedule error: ${JSON.stringify(moved)}`);
    expect(moved.starts_at).toBe(slotB.starts_at);
    expect(moved.stylist).toBe(slotB.stylist);
    // Old slot is bookable again.
    const again = mustAvail(store, "blowout", dayA);
    expect(again.slots.map((s) => s.slot_id)).toContain(slotA.slot_id);
  });
});

describe("T4: cancel then re-book", () => {
  it("freed slot is bookable and re-books successfully", () => {
    const store = freshStore();
    const date = openDate();
    const slot = mustAvail(store, "haircut", date).slots[0];
    const booking = mustBook(store, mustQuote(store, slot.slot_id).quote_id);
    const cancelled = store.cancelAppointment(booking.booking_id, AVA);
    if ("ok" in cancelled) throw new Error(`cancel error: ${JSON.stringify(cancelled)}`);
    expect(cancelled.cancelled).toBe(true);
    const freed = mustAvail(store, "haircut", date);
    expect(freed.slots.map((s) => s.slot_id)).toContain(slot.slot_id);
    const rebooked = mustBook(store, mustQuote(store, slot.slot_id, LEO).quote_id, LEO);
    expect(rebooked.starts_at).toBe(slot.starts_at);
  });
});

describe("T5: closed day", () => {
  it("Sunday returns no slots + alternatives, never crashes", () => {
    const store = freshStore();
    const sunday = nextSunday();
    expect(torontoWeekday(sunday)).toBe(0);
    const res = mustAvail(store, "haircut", sunday);
    expect(res.closed).toBe(true);
    expect(res.slots).toHaveLength(0);
    expect(res.alternatives.length).toBeGreaterThan(0);
    expect(res.message).toMatch(/closed/i);
  });
});

describe("no-availability alternatives", () => {
  it("full day returns alternatives on adjacent days", () => {
    const store = freshStore();
    const date = openDate(7);
    // Fill the whole day: quote+book every blowout slot until none remain.
    for (let i = 0; i < 60; i++) {
      const avail = mustAvail(store, "blowout", date);
      if (avail.slots.length === 0) break;
      mustBook(store, mustQuote(store, avail.slots[0].slot_id).quote_id);
    }
    const full = mustAvail(store, "blowout", date);
    expect(full.slots).toHaveLength(0);
    expect(full.alternatives.length).toBeGreaterThan(0);
    expect(full.message).toMatch(/alternative/i);
  });
});

describe("validation + misc", () => {
  it("unknown service returns clear error with valid ids", () => {
    const res = freshStore().checkAvailability("perm", openDate());
    expect("ok" in res && res.ok === false).toBe(true);
  });
  it("preferred_time sorts closest-first", () => {
    const store = freshStore();
    const date = openDate();
    const res = mustAvail(store, "haircut", date);
    const pref = store.checkAvailability("haircut", date, "14:00");
    if ("ok" in pref) throw new Error("unexpected error");
    expect(pref.slots).toHaveLength(res.slots.length);
    const firstStart = pref.slots[0].starts_at;
    // Closest slot to 14:00 should be within ~1h when the day is open.
    expect(Math.abs(Date.parse(firstStart) - Date.parse(`${date}T14:00:00${firstStart.slice(-6)}`))).toBeLessThanOrEqual(
      60 * 60 * 1000,
    );
  });
  it("booking confirmation carries the authenticated identity (no caller field)", () => {
    const store = freshStore();
    const slot = mustAvail(store, "haircut", openDate()).slots[0];
    const b = mustBook(store, mustQuote(store, slot.slot_id).quote_id);
    expect(b.customer_id).toBe("ava");
    expect(b.customer_name).toBe("Ava Chen");
  });
  it("another customer's quote/booking is indistinguishable from unknown", () => {
    const store = freshStore();
    const slot = mustAvail(store, "haircut", openDate()).slots[0];
    const quote = mustQuote(store, slot.slot_id, AVA);
    const asLeo = store.bookAppointment(quote.quote_id, LEO);
    expect("ok" in asLeo && asLeo.ok === false).toBe(true);
    const booking = mustBook(store, quote.quote_id, AVA);
    expect("ok" in store.cancelAppointment(booking.booking_id, LEO)).toBe(true);
    expect("ok" in store.rescheduleAppointment(booking.booking_id, slot.slot_id, LEO)).toBe(true);
  });
  it("unknown quote / booking ids fail clearly", () => {
    const store = freshStore();
    expect("ok" in store.bookAppointment("nope", AVA)).toBe(true);
    expect("ok" in store.cancelAppointment("nope", AVA)).toBe(true);
    expect("ok" in store.rescheduleAppointment("nope", "x", AVA)).toBe(true);
  });
});

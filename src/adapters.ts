// Provider adapter seam (Brief A).
//
// Every provider on the marketplace plugs in through the ProviderAdapter
// interface: discovery + the six booking operations. v3 ships only the
// SampleAdapter (in-memory SalonStore parameterized by provider config);
// real CRM/ERP adapters implement this interface later without touching
// the tool layer. Brief B's customer-snapshot push will also flow through
// bookAppointment here.

import type { Customer } from "./auth.js";
import {
  configHash,
  filterProviders,
  SAMPLE_ADAPTER,
  summarizeProvider,
  type Provider,
  type ProviderFilter,
  type ProviderSummary,
} from "./providers.js";
import {
  SalonStore,
  type AvailabilityResult,
  type Booking,
  type ErrorResult,
  type Quote,
  type ServiceOut,
} from "./store.js";

export type AvailabilityOutcome = AvailabilityResult | ErrorResult;
export type QuoteOutcome = Quote | ErrorResult;
export type BookingOutcome = Booking | ErrorResult;
export type RescheduleOutcome =
  | (Booking & { rescheduled_from: { starts_at: string; ends_at: string; stylist: string } })
  | ErrorResult;
export type CancelOutcome = ReturnType<SalonStore["cancelAppointment"]>;

export interface ProviderAdapter {
  readonly providerId: string;
  describe(): ProviderSummary;
  /** Refresh config without losing bookings/quotes (hot reload). */
  updateConfig(provider: Provider): void;
  /** Raw quote lookup for cross-provider mismatch detection. */
  findQuote(quote_id: string): Quote | undefined;
  listServices(): { services: ServiceOut[] };
  checkAvailability(
    service_id: string,
    date: string,
    preferred_time?: string,
  ): AvailabilityOutcome;
  createQuote(slot_id: string, customer: Customer): QuoteOutcome;
  bookAppointment(quote_id: string, customer: Customer): BookingOutcome;
  rescheduleAppointment(
    booking_id: string,
    new_slot_id: string,
    customer: Customer,
  ): RescheduleOutcome;
  cancelAppointment(booking_id: string, customer: Customer): CancelOutcome;
}

export class SampleAdapter implements ProviderAdapter {
  private store: SalonStore;
  private record: Provider;

  constructor(provider: Provider) {
    this.record = provider;
    this.store = new SalonStore(provider);
  }

  get providerId(): string {
    return this.record.id;
  }

  describe(): ProviderSummary {
    return summarizeProvider(this.record);
  }

  updateConfig(provider: Provider): void {
    this.record = provider;
    this.store.updateConfig(provider);
  }

  findQuote(quote_id: string): Quote | undefined {
    return this.store.getQuote(quote_id);
  }

  listServices(): { services: ServiceOut[] } {
    return this.store.listServices();
  }

  checkAvailability(
    service_id: string,
    date: string,
    preferred_time?: string,
  ): AvailabilityOutcome {
    return this.store.checkAvailability(service_id, date, preferred_time);
  }

  createQuote(slot_id: string, customer: Customer): QuoteOutcome {
    return this.store.createQuote(slot_id, customer);
  }

  bookAppointment(quote_id: string, customer: Customer): BookingOutcome {
    return this.store.bookAppointment(quote_id, customer);
  }

  rescheduleAppointment(
    booking_id: string,
    new_slot_id: string,
    customer: Customer,
  ): RescheduleOutcome {
    return this.store.rescheduleAppointment(booking_id, new_slot_id, customer);
  }

  cancelAppointment(booking_id: string, customer: Customer): CancelOutcome {
    return this.store.cancelAppointment(booking_id, customer);
  }
}

export interface AdapterDirectory {
  get(provider_id: string): ProviderAdapter | undefined;
  summaries(filter: ProviderFilter): ProviderSummary[];
  /** Which provider's store holds this quote (for mismatch detection). */
  findQuoteOwner(quote_id: string): ProviderAdapter | undefined;
}

/**
 * Live adapter set, synced from the provider registry on every request.
 * Syncs add new providers, hot-update changed configs, and drop removed
 * ones — bookings and quotes held by surviving adapters are preserved.
 */
export class SampleDirectory implements AdapterDirectory {
  private adapters = new Map<string, { adapter: SampleAdapter; hash: string }>();
  private records: Provider[] = [];

  sync(providers: Provider[]): void {
    const seen = new Set<string>();
    for (const p of providers) {
      if (p.adapter !== SAMPLE_ADAPTER) continue; // CLI rejects these; never crash on them
      seen.add(p.id);
      const hash = configHash(p);
      const existing = this.adapters.get(p.id);
      if (!existing) {
        this.adapters.set(p.id, { adapter: new SampleAdapter(p), hash });
      } else if (existing.hash !== hash) {
        existing.adapter.updateConfig(p);
        existing.hash = hash;
      }
    }
    for (const id of [...this.adapters.keys()]) {
      if (!seen.has(id)) this.adapters.delete(id);
    }
    this.records = providers.filter((p) => p.adapter === SAMPLE_ADAPTER);
  }

  get(provider_id: string): ProviderAdapter | undefined {
    return this.adapters.get(provider_id)?.adapter;
  }

  summaries(filter: ProviderFilter): ProviderSummary[] {
    return filterProviders(this.records, filter).map(summarizeProvider);
  }

  findQuoteOwner(quote_id: string): ProviderAdapter | undefined {
    for (const { adapter } of this.adapters.values()) {
      if (adapter.findQuote(quote_id)) return adapter;
    }
    return undefined;
  }
}

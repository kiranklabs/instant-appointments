// Thin MCP adapters: zod schemas in, JSON text out. Business logic lives
// in the per-provider adapters (src/adapters.ts).
//
// Identity is injected by the HTTP layer (authenticated bearer key) and the
// provider is resolved per call from provider_id. Tool schemas carry no
// customer identifier — there is nothing to forge.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdapterDirectory } from "./adapters.js";
import type { Customer } from "./auth.js";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function providerNotFound(provider_id: string) {
  // No other providers' data leaks into this error.
  return {
    ok: false as const,
    error: {
      code: "PROVIDER_NOT_FOUND",
      message: `Unknown provider_id "${provider_id}". Use list_providers to discover providers.`,
    },
  };
}

/** Thrown when a gated tool is invoked without an authenticated customer. */
class ToolAuthError extends Error {}

const providerIdField = z.string().describe("Provider id from list_providers.");

export function registerTools(
  server: McpServer,
  dir: AdapterDirectory,
  customer: Customer | null,
): void {
  // Defense in depth: the HTTP layer already rejects keyless calls to gated
  // tools with 401. This guard covers any future dispatch path that forgets.
  const requireCustomer = () =>
    customer ??
    (() => {
      throw new ToolAuthError();
    })();

  function gated<T>(fn: (c: Customer) => T): T | { ok: false; error: { code: string; message: string } } {
    try {
      return fn(requireCustomer());
    } catch (err) {
      if (err instanceof ToolAuthError) {
        return {
          ok: false as const,
          error: {
            code: "UNAUTHORIZED",
            message: "This tool requires a Fintake account key. Send Authorization: Bearer <key>.",
          },
        };
      }
      throw err;
    }
  }
  server.tool(
    "list_providers",
    "Discover marketplace providers. Optional filters; empty input lists all.",
    {
      category: z.string().optional().describe("Filter by category, e.g. salon, spa."),
      city: z.string().optional().describe("Filter by city, e.g. Toronto."),
      query: z.string().optional().describe("Match against provider name/category."),
    },
    async (filter) => textResult({ providers: dir.summaries(filter) }),
  );

  server.tool(
    "list_services",
    "List a provider's services with prices (CAD cents), durations, and how long each price is valid.",
    { provider_id: providerIdField },
    async ({ provider_id }) => {
      const a = dir.get(provider_id);
      return textResult(a ? a.listServices() : providerNotFound(provider_id));
    },
  );

  server.tool(
    "check_availability",
    "Show a provider's bookable slots for a service on a date (YYYY-MM-DD). Optional preferred_time (HH:MM) sorts closest-first. Closed days and full days return nearest alternatives, never a bare error.",
    {
      provider_id: providerIdField,
      service_id: z.string().describe("Service id from list_services."),
      date: z.string().describe("Date as YYYY-MM-DD (provider local time)."),
      preferred_time: z
        .string()
        .optional()
        .describe("Optional preferred start as HH:MM 24h, e.g. 14:00."),
    },
    async ({ provider_id, service_id, date, preferred_time }) => {
      const a = dir.get(provider_id);
      return textResult(
        a ? a.checkAvailability(service_id, date, preferred_time) : providerNotFound(provider_id),
      );
    },
  );

  server.tool(
    "create_quote",
    "Lock a provider slot from check_availability for 15 minutes. Returns a quote_id to pass to book_appointment.",
    {
      provider_id: providerIdField,
      slot_id: z.string().describe("slot_id from check_availability."),
    },
    async ({ provider_id, slot_id }) => {
      const a = dir.get(provider_id);
      if (!a) return textResult(providerNotFound(provider_id));
      return textResult(gated((c) => a.createQuote(slot_id, c)));
    },
  );

  server.tool(
    "book_appointment",
    "Book the authenticated customer's quoted slot at a provider. Idempotent on quote_id: booking the same quote twice returns the identical confirmation. Quotes are scoped to their issuing provider.",
    {
      provider_id: providerIdField,
      quote_id: z.string().describe("quote_id from create_quote."),
    },
    async ({ provider_id, quote_id }) => {
      const a = dir.get(provider_id);
      if (!a) return textResult(providerNotFound(provider_id));
      const res = gated((c) => a.bookAppointment(quote_id, c));
      if ("ok" in res && res.error.code === "UNAUTHORIZED") return textResult(res);
      if ("ok" in res && res.error.code === "UNKNOWN_QUOTE") {
        const owner = dir.findQuoteOwner(quote_id);
        if (owner && owner.providerId !== provider_id) {
          return textResult({
            ok: false as const,
            error: {
              code: "QUOTE_PROVIDER_MISMATCH",
              message: `Quote ${quote_id} was issued by provider "${owner.providerId}", not "${provider_id}". Book it against the issuing provider.`,
            },
          });
        }
      }
      return textResult(res);
    },
  );

  server.tool(
    "reschedule_appointment",
    "Move an active booking to a new slot at the same provider (same service). The old slot is freed.",
    {
      provider_id: providerIdField,
      booking_id: z.string().describe("booking_id from book_appointment."),
      new_slot_id: z.string().describe("slot_id from check_availability (same service)."),
    },
    async ({ provider_id, booking_id, new_slot_id }) => {
      const a = dir.get(provider_id);
      if (!a) return textResult(providerNotFound(provider_id));
      return textResult(gated((c) => a.rescheduleAppointment(booking_id, new_slot_id, c)));
    },
  );

  server.tool(
    "cancel_appointment",
    "Cancel an active booking at a provider. The slot becomes bookable again.",
    {
      provider_id: providerIdField,
      booking_id: z.string().describe("booking_id from book_appointment."),
    },
    async ({ provider_id, booking_id }) => {
      const a = dir.get(provider_id);
      if (!a) return textResult(providerNotFound(provider_id));
      return textResult(gated((c) => a.cancelAppointment(booking_id, c)));
    },
  );
}

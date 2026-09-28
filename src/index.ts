// Lumen Hair Studio MCP Connector.
// Stateless Streamable HTTP: one McpServer per POST /mcp request, all
// requests share the singleton SalonStore (single source of truth).
//
// Auth is enforced once here at the HTTP layer, before MCP dispatch:
// every POST /mcp needs `Authorization: Bearer <key>`. The verified
// customer is injected into the tool closures — tool schemas carry no
// customer identifier, so there is nothing to forge.

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CustomerRegistry,
  DEFAULT_RATE_LIMIT,
  RateLimiter,
  clientIp,
  hashKey,
  type Customer,
  type RateLimitOptions,
} from "./auth.js";
import { registerTools } from "./tools.js";
import { SampleDirectory } from "./adapters.js";
import { loadProvidersFile } from "./providers.js";
import { ensureDataFiles } from "./seed.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      customer?: Customer;
    }
  }
}

export interface AppOptions {
  /** Path to the key registry JSON file (hashes only). */
  registryPath: string;
  /** Path to the customer profiles JSON file. */
  customersPath?: string;
  /** Path to the providers registry JSON file (default: LUMEN_PROVIDERS or data/providers.json). */
  providersPath?: string;
  /** Per-key limit for authenticated tools. */
  rateLimit?: RateLimitOptions;
  /** Per-IP limit for the public surface (no key to bill against). */
  ipRateLimit?: RateLimitOptions;
}

/** Tools that write or lock inventory — identity required. */
const AUTHENTICATED_TOOLS = new Set([
  "create_quote",
  "book_appointment",
  "reschedule_appointment",
  "cancel_appointment",
]);

/** Which tool (if any) this JSON-RPC request invokes. Null for handshake/list. */
function calledTool(req: Request): string | null {
  const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
  if (!body || body.method !== "tools/call") return null;
  const name = body.params?.name;
  return typeof name === "string" ? name : null;
}

const UNAUTHORIZED_BODY = {
  error: {
    code: "UNAUTHORIZED",
    message: "Missing or invalid credentials. Send Authorization: Bearer <key>.",
  },
};

function bearerToken(req: Request): string | null {
  const header = req.get("authorization");
  if (!header) return null;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m || !m[1].trim()) return null;
  return m[1].trim();
}

export function createApp(options: AppOptions): Express {
  const customersPath =
    options.customersPath ?? process.env.LUMEN_CUSTOMERS ?? "data/customers.json";
  const registry = new CustomerRegistry(options.registryPath, customersPath);
  const keyLimiter = new RateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT);
  const ipLimiter = new RateLimiter(options.ipRateLimit ?? DEFAULT_RATE_LIMIT);
  // Live adapter set. Synced from the provider registry on every request so
  // adds/removes/config changes take effect without a restart — while the
  // adapters themselves (and their bookings/quotes) survive across syncs.
  const directory = new SampleDirectory();
  const providersPath =
    options.providersPath ?? process.env.LUMEN_PROVIDERS ?? "data/providers.json";
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "instant-appointments-mcp", version: "1.1.0" });
  });

  // Auth split (once, before MCP dispatch). Rationale: browsing is the
  // acquisition funnel, so discovery stays open; anything that writes or
  // locks inventory requires identity.
  async function splitAuth(req: Request, res: Response, next: NextFunction) {
    const tool = calledTool(req);
    if (tool !== null && AUTHENTICATED_TOOLS.has(tool)) {
      const token = bearerToken(req);
      // Identical response whether the header is missing, malformed, unknown,
      // or revoked: never reveal whether a key exists.
      const customer = token ? registry.verify(token) : null;
      if (!customer || !token) {
        res.status(401).json(UNAUTHORIZED_BODY);
        return;
      }
      const rl = keyLimiter.check(hashKey(token));
      if (!rl.allowed) {
        res.set("Retry-After", String(rl.retryAfterSec));
        res.status(429).json({
          error: {
            code: "RATE_LIMITED",
            message: `Rate limit exceeded. Retry after ${rl.retryAfterSec}s.`,
          },
        });
        return;
      }
      req.customer = customer;
      next();
      return;
    }
    // Public path (handshake, tools/list, browsing tools): no key exists to
    // bill against, so limit per client IP instead.
    const rl = ipLimiter.check(`ip:${clientIp(req)}`);
    if (!rl.allowed) {
      res.set("Retry-After", String(rl.retryAfterSec));
      res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: `Rate limit exceeded. Retry after ${rl.retryAfterSec}s.`,
        },
      });
      return;
    }
    next();
  }

  app.post("/mcp", splitAuth, async (req, res) => {
    try {
      const server = new McpServer({
        name: "instant-appointments",
        version: "1.1.0",
      });
      directory.sync(loadProvidersFile(providersPath).providers);
      registerTools(server, directory, req.customer ?? null);
      // Stateless mode: no session IDs, no long-lived SSE.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless server: method-not-allowed for session-based SSE flows.
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. POST JSON-RPC to /mcp (stateless streamable HTTP).",
      },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "No sessions in stateless mode." },
      id: null,
    });
  });

  return app;
}

// Only listen when run directly (`npm run dev` / `npm start`), not when
// imported by tests or the keys CLI.
const isMain = process.argv[1]?.endsWith("/index.js") || process.argv[1]?.endsWith("/index.ts");
if (isMain) {
  const PORT = Number(process.env.PORT ?? 3000);
  const registryPath = process.env.LUMEN_REGISTRY ?? "data/api-keys.json";
  const customersPath = process.env.LUMEN_CUSTOMERS ?? "data/customers.json";
  const providersPath = process.env.LUMEN_PROVIDERS ?? "data/providers.json";
  ensureDataFiles({ keysPath: registryPath, customersPath, providersPath });
  createApp({ registryPath, customersPath, providersPath }).listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Instant Appointments MCP listening on http://localhost:${PORT}/mcp`);
  });
}

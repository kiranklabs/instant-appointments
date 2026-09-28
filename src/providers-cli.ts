// Provider registry admin CLI (manual onboarding for v3).
// NOT an MCP tool — provider onboarding stays out of the connector surface.
//
// Usage:
//   npm run providers -- add --file ./provider.json
//   npm run providers -- list
//   npm run providers -- remove <provider_id>
//
// Registry path: LUMEN_PROVIDERS env or data/providers.json.
// Changes take effect without a server restart (re-read per request).

import { readFileSync } from "node:fs";
import {
  loadProvidersFile,
  saveProvidersFile,
  validateProvider,
  type Provider,
} from "./providers.js";

const providersPath = process.env.LUMEN_PROVIDERS ?? "data/providers.json";

function usage(): never {
  console.error("Usage: npm run providers -- <add --file <path>|list|remove <provider_id>>");
  process.exit(1);
}

export function addProvider(record: unknown): Provider {
  const errs = validateProvider(record);
  if (errs.length > 0) {
    throw new Error(`Invalid provider record:\n- ${errs.join("\n- ")}`);
  }
  const provider = record as Provider;
  const data = loadProvidersFile(providersPath);
  if (data.providers.some((p) => p.id === provider.id)) {
    throw new Error(`Provider "${provider.id}" already exists. Remove it first to replace.`);
  }
  data.providers.push(provider);
  saveProvidersFile(providersPath, data);
  return provider;
}

export function listProviders(): Provider[] {
  return loadProvidersFile(providersPath).providers;
}

export function removeProvider(provider_id: string): boolean {
  const data = loadProvidersFile(providersPath);
  const before = data.providers.length;
  data.providers = data.providers.filter((p) => p.id !== provider_id);
  if (data.providers.length === before) return false;
  saveProvidersFile(providersPath, data);
  return true;
}

const [cmd, arg1, arg2] = process.argv.slice(2);

// Only run the CLI when executed directly (`npm run providers`), not when
// imported by tests (same pattern as index.ts).
const isMain =
  process.argv[1]?.endsWith("/providers-cli.js") || process.argv[1]?.endsWith("/providers-cli.ts");
if (isMain) {
  switch (cmd) {
  case "add": {
    if (arg1 !== "--file" || !arg2) usage();
    try {
      const record = JSON.parse(readFileSync(arg2, "utf8")) as unknown;
      const added = addProvider(record);
      console.log(`Added provider "${added.id}" (${added.name}). Live on next request.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    break;
  }
  case "list": {
    const providers = listProviders();
    if (providers.length === 0) {
      console.log(`No providers in ${providersPath}.`);
      break;
    }
    for (const p of providers) {
      console.log(
        `${p.id}\t${p.name}\t${p.category}\t${p.location.city}/${p.location.area}\t${p.config.services.length} services`,
      );
    }
    break;
  }
  case "remove": {
    if (!arg1) usage();
    if (!removeProvider(arg1)) {
      console.error(`No provider "${arg1}" in ${providersPath}.`);
      process.exit(1);
    }
    console.log(`Removed provider "${arg1}". Takes effect on the next request.`);
    break;
  }
    default:
      usage();
  }
}

// Customer signup CLI — the v3 signup path (website self-serve comes later).
// NOT an MCP tool.
//
// Usage:
//   npm run customers -- create --name "Ava Patel" --phone "+14165550101" --email "ava@example.com"
// → creates the profile, mints the API key, prints the raw key ONCE.
//
// The low-level `npm run keys --` CLI stays for admin use; `customers create`
// is the normal signup path.

import {
  hashKey,
  loadRegistryFile,
  mintRawKey,
  saveRegistryFile,
} from "./auth.js";
import { createProfile } from "./customers.js";

const registryPath = process.env.LUMEN_REGISTRY ?? "data/api-keys.json";
const customersPath = process.env.LUMEN_CUSTOMERS ?? "data/customers.json";

function usage(): never {
  console.error(
    'Usage: npm run customers -- create --name "<name>" --phone "<phone>" --email "<email>"',
  );
  process.exit(1);
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  const value = args[i + 1]?.trim();
  return value ? value : null;
}

export function signupCustomer(input: { name: string; phone: string; email: string }): {
  profile: ReturnType<typeof createProfile>;
  rawKey: string;
} {
  const profile = createProfile(customersPath, input);
  const rawKey = mintRawKey();
  const data = loadRegistryFile(registryPath);
  data.entries.push({
    customer_id: profile.customer_id,
    key_hash: hashKey(rawKey),
    key_hint: rawKey.slice(0, 12),
    revoked: false,
    created_at: new Date().toISOString(),
  });
  saveRegistryFile(registryPath, data);
  return { profile, rawKey };
}

const isMain =
  process.argv[1]?.endsWith("/customers-cli.js") || process.argv[1]?.endsWith("/customers-cli.ts");
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "create") usage();
  const name = flag(rest, "--name");
  const phone = flag(rest, "--phone");
  const email = flag(rest, "--email");
  if (!name || !phone || !email) usage();
  try {
    const { profile, rawKey } = signupCustomer({ name, phone, email });
    console.log(`Created customer "${profile.customer_id}" (${profile.name}).`);
    console.log(`API key (shown ONCE — store it securely, only the hash is kept):`);
    console.log(rawKey);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

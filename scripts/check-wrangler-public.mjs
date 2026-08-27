#!/usr/bin/env node
// scripts/check-wrangler-public.mjs
// Guards against leaking any maintainer's private domain to public forkers.
// Run via `npm run lint:wrangler`. Wired into `deploy:workers` so a regression
// fails CI before hitting Cloudflare.
//
// File checked:
//   wrangler.jsonc   ← committed, read by Cloudflare Workers Builds.
//
// Checks (intentionally minimal):
//   1. Forbidden hosts (kass.cc / cdnc.us / intruxt.com) must NEVER appear.
//      These are the maintainer's personal deploy hosts — catching them
//      alone blocks the original leak; we don't also have to fingerprint
//      specific D1 / KV UUIDs.
//   2. Placeholder D1 / KV IDs must NOT survive. Their presence means the
//      focker has not run `provision:cloudflare` yet, and Workers Builds
//      would fail at Cloudflare API level — fail fast here with a clearer
//      pointer to the fix.
//
// We deliberately do NOT block arbitrary real D1 / KV UUIDs. A focker's own
// real values are exactly what should be in the file after provision runs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const TARGET = resolve(ROOT, "wrangler.jsonc");
const PLACEHOLDER_D1 = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_KV = "00000000000000000000000000000000";

// Domains/hostnames owned by the upstream maintainer — must NEVER appear in
// the committed file. Add new entries when spinning up a new personal deploy.
const FORBIDDEN_HOSTS = [
  "kass.cc",
  "cdnc.us",
  "intruxt.com",
];

let raw;
try {
  raw = readFileSync(TARGET, "utf8");
} catch (err) {
  console.error(`✘ cannot read ${TARGET}: ${err.message}`);
  process.exit(2);
}

const violations = [];

raw.split(/\r?\n/).forEach((line, i) => {
  // Strip line comments so URLs inside `// foo` don't trigger.
  const code = line.replace(/\/\/.*$/, "");
  const lineNo = i + 1;
  for (const host of FORBIDDEN_HOSTS) {
    if (code.includes(host)) {
      violations.push(`${TARGET.split("/").pop()}:${lineNo}: forbidden host "${host}" — never commit the maintainer's personal deploy host to the public repo`);
    }
  }
});

// Placeholder IDs must not survive in a deployable config: the focker has
// not run provision:cloudflare yet and Workers Builds will fail at the
// Cloudflare API with a less obvious error.
if (raw.includes(`"database_id": "${PLACEHOLDER_D1}"`)) {
  violations.push(`${TARGET.split("/").pop()}: placeholder D1 id still in place — run \`npm run provision:cloudflare\` to overwrite with real values`);
}
if (raw.includes(`"id": "${PLACEHOLDER_KV}"`)) {
  violations.push(`${TARGET.split("/").pop()}: placeholder KV id still in place — run \`npm run provision:cloudflare\` to overwrite with real values`);
}

if (violations.length === 0) {
  console.log("✓ wrangler.jsonc clean (no forbidden hosts, no surviving placeholders)");
  process.exit(0);
}

console.error(`✘ lint:wrangler failed (${violations.length} issue${violations.length === 1 ? "" : "s"})`);
for (const v of violations) console.error(`  - ${v}`);
console.error("");
console.error("wrangler.jsonc is what Cloudflare Workers Builds reads. Forkers clone it as-is.");
console.error("Keep forbidden hosts (kass.cc / cdnc.us / intruxt.com) out, and run");
console.error("`npm run provision:cloudflare` so your real values overwrite the placeholders");
console.error("before your first push. After that, this lint only catches new host leaks.");
process.exit(1);
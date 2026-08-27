#!/usr/bin/env node
// scripts/check-wrangler-public.mjs
// Guards against leaking any maintainer's private domain or resource IDs to
// public forkers. Run via `npm run lint:wrangler`. Wired into `deploy:workers`
// so a regression fails CI before hitting Cloudflare.
//
// File checked:
//   wrangler.jsonc    ← committed, read by Cloudflare Workers Builds.
//                       Must NEVER contain a forbidden host or a real UUID;
//                       a placeholder UUID (`00000000-…`) is rejected too —
//                       the file must be rewritten by `npm run
//                       provision:cloudflare` before deploy.

import { existsSync, readFileSync } from "node:fs";
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

// Real Cloudflare resource IDs are 32-char hex (D1) or 32-char hex w/o dashes
// (KV). The placeholder templates use all-zeros; anything else is a leak.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX32_RE = /\b[0-9a-f]{32}\b/gi;

let raw;
try {
  raw = readFileSync(TARGET, "utf8");
} catch (err) {
  console.error(`✘ cannot read ${TARGET}: ${err.message}`);
  process.exit(2);
}

const violations = [];

raw.split(/\r?\n/).forEach((line, i) => {
  const code = line.replace(/\/\/.*$/, "");
  const lineNo = i + 1;
  for (const host of FORBIDDEN_HOSTS) {
    if (code.includes(host)) {
      violations.push(`${TARGET.split("/").pop()}:${lineNo}: forbidden host "${host}" — never commit personal deploy hosts to the public repo`);
    }
  }
  for (const m of code.matchAll(UUID_RE)) {
    if (m[0].toLowerCase() !== PLACEHOLDER_D1) {
      violations.push(`${TARGET.split("/").pop()}:${lineNo}: real D1 id "${m[0]}" — placeholder ${PLACEHOLDER_D1} only`);
    }
  }
  for (const m of code.matchAll(HEX32_RE)) {
    if (m[0].toLowerCase() !== PLACEHOLDER_KV) {
      violations.push(`${TARGET.split("/").pop()}:${lineNo}: real KV id "${m[0]}" — placeholder ${PLACEHOLDER_KV} only`);
    }
  }
});

// Placeholder UUIDs must not survive in a deployable config: the focker has
// not run provision:cloudflare and Workers Builds will fail on Cloudflare API
// errors anyway — fail fast here with a clearer message.
if (raw.includes(`"database_id": "${PLACEHOLDER_D1}"`)) {
  violations.push(`${TARGET.split("/").pop()}: placeholder D1 id still in place — run \`npm run provision:cloudflare\` to overwrite with real values`);
}
if (raw.includes(`"id": "${PLACEHOLDER_KV}"`)) {
  violations.push(`${TARGET.split("/").pop()}: placeholder KV id still in place — run \`npm run provision:cloudflare\` to overwrite with real values`);
}

if (violations.length === 0) {
  console.log("✓ wrangler.jsonc clean (no personal hosts, no real resource ids)");
  process.exit(0);
}

console.error(`✘ lint:wrangler failed (${violations.length} issue${violations.length === 1 ? "" : "s"})`);
for (const v of violations) console.error(`  - ${v}`);
console.error("");
console.error("wrangler.jsonc is what Cloudflare Workers Builds reads. Forkers clone it as-is.");
console.error("Keep it as a placeholder template; provision writes your real values locally,");
console.error("and you push them. Upstream must NEVER contain personal hosts or real IDs.");
process.exit(1);
#!/usr/bin/env node
// scripts/check-wrangler-public.mjs
// Guards against leaking any maintainer's private domain or resource IDs to
// public forkers. Run via `npm run lint:wrangler`. Wired into `deploy:workers`
// so a regression fails CI before hitting Cloudflare.
//
// Two files are checked:
//   wrangler.jsonc.example   ← upstream committed template; MUST be clean
//                                placeholders only. Forbidden-host / real-UUID
//                                hits here mean a maintainer leaked their
//                                personal deploy values.
//   wrangler.jsonc           ← focker's personalized config produced by
//                                `npm run provision:cloudflare`. If absent,
//                                deploy:workers fails fast (provision has not
//                                run). If present, it must not contain any
//                                forbidden host (kass.cc / cdnc.us / etc.).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const EXAMPLE = resolve(ROOT, "wrangler.jsonc.example");
const PERSONAL = resolve(ROOT, "wrangler.jsonc");
const PLACEHOLDER_D1 = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_KV = "00000000000000000000000000000000";

// Domains/hostnames owned by the upstream maintainer — must NEVER appear in
// either committed file. Add new entries when spinning up a new personal deploy.
const FORBIDDEN_HOSTS = [
  "kass.cc",
  "cdnc.us",
  "intruxt.com",
];

// Real Cloudflare resource IDs are 32-char hex (D1) or 32-char hex w/o dashes
// (KV). The placeholder templates use all-zeros; anything else is a leak.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX32_RE = /\b[0-9a-f]{32}\b/gi;

function lintFile(path, { allowPlaceholders }) {
  const violations = [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { violations, raw: null };
  }
  raw.split(/\r?\n/).forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    const lineNo = i + 1;
    for (const host of FORBIDDEN_HOSTS) {
      if (code.includes(host)) {
        violations.push(`${path.split("/").pop()}:${lineNo}: forbidden host "${host}"`);
      }
    }
    for (const m of code.matchAll(UUID_RE)) {
      const isPlaceholder = m[0].toLowerCase() === PLACEHOLDER_D1;
      if (!isPlaceholder || !allowPlaceholders) {
        violations.push(`${path.split("/").pop()}:${lineNo}: ${isPlaceholder ? "" : "real "}D1 id "${m[0]}"`);
      }
    }
    for (const m of code.matchAll(HEX32_RE)) {
      const isPlaceholder = m[0].toLowerCase() === PLACEHOLDER_KV;
      if (!isPlaceholder || !allowPlaceholders) {
        violations.push(`${path.split("/").pop()}:${lineNo}: ${isPlaceholder ? "" : "real "}KV id "${m[0]}"`);
      }
    }
  });
  return { violations, raw };
}

const violations = [];

// 1. wrangler.jsonc.example is the committed template — must be clean and pure
//    placeholder. Real UUIDs and personal hosts are never allowed here.
const example = lintFile(EXAMPLE, { allowPlaceholders: true });
if (example.raw === null) {
  violations.push(`${EXAMPLE}: missing — the upstream template must exist so forkers can copy it`);
} else {
  for (const v of example.violations) {
    if (v.includes("forbidden host") || v.includes("real ")) {
      violations.push(`${v} — upstream template must be a clean placeholder, not personal values`);
    } else {
      // Placeholder UUIDs are intentional in the .example file. Sanity-check
      // that they appear at all (so we don't ship a "template" that's empty).
    }
  }
}

// 2. wrangler.jsonc is focker-personalized. If absent, focker has not run
//    provision:cloudflare — fail fast so Workers Builds doesn't ship a
//    half-configured Worker.
if (!existsSync(PERSONAL)) {
  violations.push(`${PERSONAL}: missing — run \`npm run provision:cloudflare\` first; Workers Builds reads this file at deploy time`);
} else {
  const personal = lintFile(PERSONAL, { allowPlaceholders: false });
  // Any placeholder hit in a real config means the focker forgot to provision.
  // Surface those as a separate, clearer error.
  for (const v of personal.violations) {
    if (v.includes("forbidden host")) {
      violations.push(`${v} — never commit personal deploy hosts to the public repo`);
    } else if (!v.includes("real ")) {
      violations.push(`${v} — placeholder survived in committed config; run \`npm run provision:cloudflare\` to overwrite with real values`);
    } else {
      violations.push(v);
    }
  }
}

if (violations.length === 0) {
  console.log("✓ wrangler.jsonc(.example) clean (no personal hosts, no leaked resource ids)");
  process.exit(0);
}

console.error(`✘ lint:wrangler failed (${violations.length} issue${violations.length === 1 ? "" : "s"})`);
for (const v of violations) console.error(`  - ${v}`);
console.error("");
console.error("wrangler.jsonc is what Cloudflare Workers Builds reads. Forkers clone it as-is.");
console.error("Keep wrangler.jsonc.example as a placeholder template; provision writes your real");
console.error("values locally, and you push them. Upstream must NEVER contain personal hosts.");
process.exit(1);
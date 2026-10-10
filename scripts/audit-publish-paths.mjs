// Static audit: shop listings may only become published through the canonical
// Sales Test Gate writer (publishCanonicalSalesTestListing in
// lib/market/select-sales-tests.ts). Any other source line that sets
// published:true, pipeline_status "published" or a PUBLISHED stage fails CI
// unless it is listed below with the reason it is not a publication decision.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanned = ["lib", "app", "scripts", "supabase"];
const PATTERNS = [
  /\bpublished\s*:\s*true\b/,
  /pipeline_status\s*:\s*["']published["']/,
  /pipeline_stage\s*:\s*["'](PUBLISHED|BASE_PUBLISHED)["']/,
  /\bset\s+published\s*=\s*true\b/i,
];

// file -> exact number of matching lines allowed, and why.
const ALLOWED = {
  "lib/market/select-sales-tests.ts": { count: 4, why: "canonical writer: published, PUBLISHED stage and status after evaluateSalesTestGate, plus its result value" },
  "lib/shopify/admin.ts": { count: 1, why: "Shopify publication-state return value, not a shop_listings write" },
  "lib/channels/base-publisher.ts": { count: 1, why: "BASE_PUBLISHED status after hasPassedSalesTestGate on an already-published listing (downstream delivery)" },
};

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(ts|tsx|mjs|js|sql)$/.test(entry)) yield full;
  }
}

const violations = [];
const counts = {};
for (const base of scanned) {
  for (const file of files(path.join(root, base))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel.startsWith("scripts/test-") || rel === "scripts/audit-publish-paths.mjs") continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (/tracer_published\s*:/.test(code)) return; // NEWFIND attestation flag, not a listing write
      if (/:\s*Promise<\{\s*published:\s*true/.test(code)) return; // return type, not a write
      if (PATTERNS.some((pattern) => pattern.test(code))) {
        counts[rel] = (counts[rel] ?? 0) + 1;
        if (!ALLOWED[rel]) violations.push(`${rel}:${index + 1}: ${line.trim().slice(0, 160)}`);
      }
    });
  }
}

for (const [rel, rule] of Object.entries(ALLOWED)) {
  if ((counts[rel] ?? 0) !== rule.count) violations.push(`${rel}: expected exactly ${rule.count} publication line(s) (${rule.why}), found ${counts[rel] ?? 0}`);
}

if (violations.length) {
  console.error("Publication path audit FAILED:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Publication path audit passed:");
  for (const [rel, rule] of Object.entries(ALLOWED)) console.log(`  ${rel}: ${counts[rel]} line(s) — ${rule.why}`);
}

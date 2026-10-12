import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sources = [
  ["direct runner", new URL("./direct-900-gate.ts", import.meta.url)],
  ["scheduled sales gate", new URL("../app/api/cron/sales-test-publication/route.ts", import.meta.url)],
];

for (const [label, url] of sources) {
  const source = readFileSync(url, "utf8");
  // Supply discovery is not canonical identity. Neither bulk runner nor cron
  // may treat supply_discovered rows as eligible for product publication.
  assert.match(source, /\.eq\(["']identity_status["'],\s*["']linked["']\)/, label);
  assert.doesNotMatch(source, /identity_status\.eq\.supply_discovered/, label);
}
console.log("Sales publication identity gate: both entry points require canonical linked identity");

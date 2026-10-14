import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const procurementInit = await readFile(new URL("../lib/procurement/init.ts", import.meta.url), "utf8");

assert.ok(!vercel.crons.some((cron) => cron.path === "/api/cron/orosy-bulk-import"), "Orosy import cron must be removed");
assert.ok(!procurementInit.includes("orosySupplierAdapter"), "Orosy procurement adapter must not be registered");

for (const path of [
  "../app/api/cron/orosy-bulk-import/route.ts",
  "../app/api/intelligence/orosy-search/route.ts",
  "../app/api/intelligence/orosy-listing-inspect/route.ts",
]) {
  await assert.rejects(access(new URL(path, import.meta.url)), { code: "ENOENT" }, `Orosy endpoint must be removed: ${path}`);
}
console.log("Orosy ingress removal policy: 5 assertions passed");

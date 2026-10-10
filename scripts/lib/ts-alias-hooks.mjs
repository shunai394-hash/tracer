// Module resolution hooks for running application TypeScript under
// `node --experimental-strip-types` in regression tests:
// - "@/x" resolves to the repository root (tsconfig paths), adding ".ts" or "/index.ts";
// - extensionless relative imports get ".ts";
// - "server-only" becomes an empty module;
// - TRACER_TEST_MODULE_OVERRIDES maps specifiers to test doubles (JSON object of
//   specifier -> repository-relative file), e.g. the Supabase admin client, so
//   tests never reach a real database or network service.
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Default doubles: tests never reach a real database or the FX network API.
const overrides = {
  "@/lib/supabase/admin": "scripts/lib/fake-supabase-admin.mjs",
  "@/lib/intelligence/fx": "scripts/lib/fake-fx.mjs",
  ...JSON.parse(process.env.TRACER_TEST_MODULE_OVERRIDES || "{}"),
};

function withTsExtension(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
  if (Object.hasOwn(overrides, specifier)) {
    return { url: pathToFileURL(path.join(root, overrides[specifier])).href, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const file = withTsExtension(path.join(root, specifier.slice(2)));
    if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:") && !path.extname(specifier)) {
    const file = withTsExtension(path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier));
    if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

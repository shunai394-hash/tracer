import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withSourceExtension(file) {
  if (path.extname(file)) return file;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    for (const name of ["index.ts", "index.tsx", "index.js"]) {
      const candidate = path.join(file, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const extension of [".ts", ".tsx", ".js"]) {
    if (fs.existsSync(`${file}${extension}`)) return `${file}${extension}`;
  }
  return file;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return {
      url: pathToFileURL(path.join(root, "node_modules", "server-only", "empty.js")).href,
      shortCircuit: true,
    };
  }
  if (specifier === "@/lib/supabase/admin" && process.env.TRACER_TEST_MOCK_SUPABASE === "1") {
    return nextResolve(specifier, context);
  }
  if (specifier.startsWith("@/")) {
    return nextResolve(pathToFileURL(withSourceExtension(path.join(root, specifier.slice(2)))).href, context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const parent = fileURLToPath(context.parentURL);
    if (parent.startsWith(root) && !parent.includes(`${path.sep}node_modules${path.sep}`)) {
      return nextResolve(pathToFileURL(withSourceExtension(path.resolve(path.dirname(parent), specifier))).href, context);
    }
  }
  return nextResolve(specifier, context);
}

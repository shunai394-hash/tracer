import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const [gateSource, typesSource] = await Promise.all([
  readFile(new URL("../lib/ordering/gates.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/ordering/types.ts", import.meta.url), "utf8"),
]);
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
};
const compiledTypes = ts.transpileModule(typesSource, { compilerOptions }).outputText;
const typesUrl = `data:text/javascript;base64,${Buffer.from(compiledTypes).toString("base64")}`;
const compiledGate = ts.transpileModule(
  gateSource.replace('from "@/lib/ordering/types"', `from "${typesUrl}"`),
  { compilerOptions },
).outputText;
const { verifyOrderGateInvariants } = await import(
  `data:text/javascript;base64,${Buffer.from(compiledGate).toString("base64")}`
);

const result = verifyOrderGateInvariants();
const failed = result.cases.filter((item) => item.actual !== item.expected);
assert.equal(result.ok, true, `Order gate invariants failed: ${JSON.stringify(failed)}`);
console.log(`Order gate invariants: ${result.cases.length} cases passed`);

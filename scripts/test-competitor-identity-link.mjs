import assert from "node:assert/strict";
import { verifyCompetitorIdentityLinkInvariants } from "../lib/market/competitor-identity-link.ts";

const result = verifyCompetitorIdentityLinkInvariants();
const failed = result.cases.filter((item) => item.actual !== item.expected);
assert.equal(result.ok, true, `competitor identity link invariants failed: ${JSON.stringify(failed)}`);
console.log(`competitor identity link invariants: ${result.cases.length} cases passed`);

import assert from "node:assert/strict";
import { getBasePublicationOutcome } from "../lib/channels/base-publication-result.ts";

assert.deepEqual(getBasePublicationOutcome({ failed: 0, skipped: 0 }), { ok: true, status: 200 });
assert.deepEqual(getBasePublicationOutcome({ failed: 1, skipped: 0 }), { ok: false, status: 207 });
assert.deepEqual(getBasePublicationOutcome({ failed: 0, skipped: 1 }), { ok: false, status: 207 });
assert.deepEqual(getBasePublicationOutcome({ failed: 2, skipped: 3 }), { ok: false, status: 207 });

console.log("BASE publication outcome regression checks passed (4 cases).");

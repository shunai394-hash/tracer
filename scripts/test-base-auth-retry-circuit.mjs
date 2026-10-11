import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASE_AUTH_REAUTH_REQUIRED, isBaseAuthenticationFailure } from "../lib/channels/base-auth-failure.ts";

assert.equal(isBaseAuthenticationFailure('BASE API HTTP 400: {"error":"invalid_request","error_description":"アクセストークンが無効です。"}'), true);
assert.equal(isBaseAuthenticationFailure("BASE API HTTP 401: invalid_token"), true);
assert.equal(isBaseAuthenticationFailure("BASE API HTTP 400: item title is invalid"), false);
assert.equal(isBaseAuthenticationFailure(String.raw`BASE API HTTP 400: {"error_description":"\u30a2\u30af\u30bb\u30b9\u30c8\u30fc\u30af\u30f3\u304c\u7121\u52b9\u3067\u3059\u3002"}`), true);
assert.equal(BASE_AUTH_REAUTH_REQUIRED, "base_auth_invalid_reauthorization_required");

const route = readFileSync("app/api/cron/unpublish-unlinked/route.ts", "utf8");
assert.ok(route.includes("base_last_error.neq.base_auth_invalid_reauthorization_required"), "query must exclude unresolved BASE token rejection");
assert.ok(route.includes("const baseRowsToPause = unlinked"), "token rejection circuit must pause all currently-unlinked BASE rows, not just the current batch");
assert.ok(route.includes("updateInChunks(baseRowsToPause"), "token rejection circuit must persist markers for every affected BASE row using bounded update chunks");
assert.ok(route.includes("collectAllPages"), "candidate scan must use the shared complete-pagination helper");
const pagination = readFileSync("lib/db/collect-all-pages.ts", "utf8");
assert.ok(route.includes(".range(from, from + size - 1)"), "candidate scan must fetch bounded pages beyond the first 1,000 rows");
assert.ok(route.includes(".order(\"id\", { ascending: true })"), "pagination must use a deterministic tie-breaker");
assert.ok(pagination.includes("if (rows.length < pageSize) return { data, error: null, offset: null };"), "pagination must stop only after the final partial page");
assert.ok(route.includes("ids.slice(offset, offset + 500)"), "bulk updates must be chunked to bounded ID lists");
assert.ok(route.includes("stage: \"read\", offset: scan.offset"), "page read failures must fail closed with the failing offset");
assert.ok(pagination.includes("if (result.error) return { data: [], error: result.error, offset: from };"), "page read failures must discard partial rows and return the failing offset");
assert.ok(route.includes("baseAuthReauthorizationRequired"), "report must surface the authentication circuit state");
console.log("BASE invalid-token retry circuit verified");

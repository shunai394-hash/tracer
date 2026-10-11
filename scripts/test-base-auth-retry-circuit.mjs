import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASE_AUTH_REAUTH_REQUIRED, isBaseAuthenticationFailure } from "../lib/channels/base-auth-failure.ts";

assert.equal(isBaseAuthenticationFailure('BASE API HTTP 400: {"error":"invalid_request","error_description":"アクセストークンが無効です。"}'), true);
assert.equal(isBaseAuthenticationFailure("BASE API HTTP 401: invalid_token"), true);
assert.equal(isBaseAuthenticationFailure("BASE API HTTP 400: item title is invalid"), false);
assert.equal(isBaseAuthenticationFailure('BASE API HTTP 400: {"error":"invalid_request","error_description":"\\\\u30a2\\\\u30af\\\\u30bb\\\\u30b9\\\\u30c8\\\\fc\\\\u30fc\\\\u30af\\\\u30f3\\\\u304c\\\\u7121\\\\u52b9\\\\u3067\\\\u3059\\\\u3002"}'), true);
assert.equal(BASE_AUTH_REAUTH_REQUIRED, "base_auth_invalid_reauthorization_required");

const route = readFileSync("app/api/cron/unpublish-unlinked/route.ts", "utf8");
assert.match(route, /base_last_error\\.neq\\.base_auth_invalid_reauthorization_required/, "query must exclude listings whose BASE token rejection is unresolved");
assert.match(route, /basePending\\.map/, "token rejection circuit must mark the affected bounded batch");
assert.match(route, /baseAuthReauthorizationRequired/, "report must surface the authentication circuit state");
console.log("BASE invalid-token retry circuit verified");

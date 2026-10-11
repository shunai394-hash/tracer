import test from "node:test";
import assert from "node:assert/strict";
import { verifyAdminRequest } from "../lib/security/verify-admin-request.ts";

function deps({ user = { email: "admin@example.com" }, error = null, allowlist = "admin@example.com", config = { url: "https://example.supabase.co", anonKey: "public-test-key" }, throwGetUser = false } = {}) {
  const calls = { createClient: 0, getUser: [], config: 0 };
  return {
    calls,
    dependencies: {
      getPublicConfig() { calls.config++; return config; },
      allowedEmails: allowlist,
      createAuthClient(url, anonKey, token) {
        calls.createClient++;
        assert.equal(url, config.url);
        assert.equal(anonKey, config.anonKey);
        return { auth: { async getUser(receivedToken) {
          calls.getUser.push(receivedToken);
          if (throwGetUser) throw new Error("auth unavailable");
          return { data: { user }, error };
        } } };
      },
    },
  };
}
const request = (authorization) => new Request("https://tracer.invalid/api/orders", {
  headers: authorization ? { authorization } : {},
});

test("anonymous requests are rejected before Supabase client creation", async () => {
  const d = deps();
  assert.deepEqual(await verifyAdminRequest(request(), d.dependencies), {
    ok: false, status: 401, error: "authentication_required",
  });
  assert.equal(d.calls.createClient, 0);
  assert.equal(d.calls.getUser.length, 0);
});

test("invalid session is rejected with 401", async () => {
  const d = deps({ user: null, error: new Error("invalid token") });
  assert.deepEqual(await verifyAdminRequest(request("Bearer bad-token"), d.dependencies), {
    ok: false, status: 401, error: "invalid_authentication",
  });
});

test("missing allowlist and non-admin users fail closed with 403", async (t) => {
  await t.test("empty allowlist", async () => {
    const d = deps({ allowlist: " , " });
    assert.deepEqual(await verifyAdminRequest(request("Bearer valid"), d.dependencies), {
      ok: false, status: 403, error: "admin_access_required",
    });
  });
  await t.test("non-admin", async () => {
    const d = deps({ user: { email: "visitor@example.com" } });
    assert.deepEqual(await verifyAdminRequest(request("Bearer valid"), d.dependencies), {
      ok: false, status: 403, error: "admin_access_required",
    });
  });
});

test("allowlisted admin email matching is trimmed and case-insensitive", async () => {
  const d = deps({ user: { email: "Admin@Example.com" }, allowlist: " other@example.com, admin@example.com " });
  assert.deepEqual(await verifyAdminRequest(request("Bearer good-token"), d.dependencies), {
    ok: true, admin: { email: "Admin@Example.com" },
  });
  assert.deepEqual(d.calls.getUser, ["good-token"]);
});

test("missing Supabase config and auth exceptions fail closed with 503", async (t) => {
  await t.test("missing config", async () => {
    const d = deps({ config: { url: "", anonKey: "" } });
    assert.deepEqual(await verifyAdminRequest(request("Bearer valid"), d.dependencies), {
      ok: false, status: 503, error: "authentication_unavailable",
    });
    assert.equal(d.calls.createClient, 0);
  });
  await t.test("auth exception", async () => {
    const d = deps({ throwGetUser: true });
    assert.deepEqual(await verifyAdminRequest(request("Bearer valid"), d.dependencies), {
      ok: false, status: 503, error: "authentication_unavailable",
    });
  });
});

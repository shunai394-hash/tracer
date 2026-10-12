import assert from "node:assert/strict";
import { verifyGitHubOidcToken } from "../lib/security/github-oidc-verifier.ts";

const audience = "https://tracer-pied-alpha.vercel.app";
const expectedWorkflowRef =
  "shunai394-hash/tracer/.github/workflows/base-product-backup.yml@refs/heads/main";
const now = Math.floor(Date.now() / 1000);

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", publicKey);
Object.assign(publicJwk, { kid: "test-key", alg: "RS256", use: "sig" });

globalThis.fetch = async () =>
  new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function token(claimOverrides = {}, headerOverrides = {}, signingKey = privateKey) {
  const header = { alg: "RS256", kid: "test-key", ...headerOverrides };
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: audience,
    exp: now + 300,
    nbf: now - 1,
    repository: "shunai394-hash/tracer",
    ref: "refs/heads/main",
    workflow_ref: expectedWorkflowRef,
    ...claimOverrides,
  };
  const input = `${encode(header)}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

assert.equal(await verifyGitHubOidcToken(await token(), expectedWorkflowRef), true, "valid signed token accepted");
assert.equal(await verifyGitHubOidcToken(await token(), "shunai394-hash/tracer/.github/workflows/other.yml@refs/heads/main"), false, "wrong expected workflow rejected");
assert.equal(await verifyGitHubOidcToken(await token({ exp: now - 1 }), expectedWorkflowRef), false, "expired token rejected");
assert.equal(await verifyGitHubOidcToken(await token({ exp: String(now + 300) }), expectedWorkflowRef), false, "string expiry rejected");
assert.equal(await verifyGitHubOidcToken(await token({ nbf: "0" }), expectedWorkflowRef), false, "string not-before rejected");
assert.equal(await verifyGitHubOidcToken(await token({ aud: "https://wrong.example" }), expectedWorkflowRef), false, "wrong audience rejected");
assert.equal(await verifyGitHubOidcToken(await token({ repository: "attacker/repo" }), expectedWorkflowRef), false, "wrong repository rejected");
assert.equal(await verifyGitHubOidcToken(await token({ ref: "refs/heads/feature" }), expectedWorkflowRef), false, "wrong branch rejected");
assert.equal(await verifyGitHubOidcToken(await token({ workflow_ref: "shunai394-hash/tracer/.github/workflows/other.yml@refs/heads/main" }), expectedWorkflowRef), false, "wrong workflow claim rejected");
assert.equal(await verifyGitHubOidcToken(await token({ iss: "https://attacker.example" }), expectedWorkflowRef), false, "wrong issuer rejected");
assert.equal(await verifyGitHubOidcToken(await token({}, { alg: "HS256" }), expectedWorkflowRef), false, "wrong algorithm rejected");
assert.equal(await verifyGitHubOidcToken("not.a.jwt", expectedWorkflowRef), false, "malformed token rejected");

const { privateKey: attackerPrivateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
assert.equal(await verifyGitHubOidcToken(await token({}, {}, attackerPrivateKey), expectedWorkflowRef), false, "invalid signature rejected");

console.log("GitHub OIDC verifier: 13 runtime assertions passed");

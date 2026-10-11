import "server-only";

import { NextResponse } from "next/server";

type GitHubOidcClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  repository?: string;
  ref?: string;
  workflow_ref?: string;
};

type GitHubJwk = {
  kid?: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
};

// Only these reviewed main-branch workflows may use GitHub OIDC for automation APIs.
// New workflows must be explicitly reviewed and added here; a repo-wide prefix is not sufficient.
const ALLOWED_GITHUB_OIDC_WORKFLOW_REFS = new Set([
  "shunai394-hash/tracer/.github/workflows/tracer-production-patrol-15m.yml@refs/heads/main",
  "shunai394-hash/tracer/.github/workflows/tracer-supply-first.yml@refs/heads/main",
  "shunai394-hash/tracer/.github/workflows/tracer-production-smoke.yml@refs/heads/main",
  "shunai394-hash/tracer/.github/workflows/tracer-publish-cj-now.yml@refs/heads/main",
  "shunai394-hash/tracer/.github/workflows/tracer-product-trace.yml@refs/heads/main",
  "shunai394-hash/tracer/.github/workflows/tracer-unpublish-unlinked.yml@refs/heads/main",
  "shunai394-hash/tracer/.github/workflows/tracer-shopify-auth-check.yml@refs/heads/main",
  "shunai394-hash/tracer/.github/workflows/tracer-reach-500-now.yml@refs/heads/main",
]);

let jwksCache: { expiresAt: number; keys: GitHubJwk[] } | null = null;

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function parseJson<T>(value: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(value)) as T;
}

async function getGitHubSigningKey(kid: string): Promise<GitHubJwk | null> {
  const now = Date.now();
  if (!jwksCache || jwksCache.expiresAt <= now) {
    const response = await fetch(
      "https://token.actions.githubusercontent.com/.well-known/jwks",
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { keys?: GitHubJwk[] };
    jwksCache = {
      expiresAt: now + 10 * 60_000,
      keys: body.keys ?? [],
    };
  }
  return jwksCache.keys.find((key) => key.kid === kid) ?? null;
}

async function verifyGitHubOidcToken(token: string): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const header = parseJson<{ alg?: string; kid?: string }>(
      base64UrlDecode(parts[0]),
    );
    if (header.alg !== "RS256" || !header.kid) return false;

    const claims = parseJson<GitHubOidcClaims>(base64UrlDecode(parts[1]));
    const now = Math.floor(Date.now() / 1000);

    if (claims.iss !== "https://token.actions.githubusercontent.com") return false;
    if (
      !(
        claims.aud === "https://tracer-pied-alpha.vercel.app" ||
        (Array.isArray(claims.aud) &&
          claims.aud.includes("https://tracer-pied-alpha.vercel.app"))
      )
    ) return false;
    if (!claims.exp || claims.exp <= now) return false;
    if (claims.nbf && claims.nbf > now + 30) return false;
    if (claims.repository !== "shunai394-hash/tracer") return false;
    if (claims.ref !== "refs/heads/main") return false;
    if (
      typeof claims.workflow_ref !== "string" ||
      !ALLOWED_GITHUB_OIDC_WORKFLOW_REFS.has(claims.workflow_ref)
    ) return false;

    const jwk = await getGitHubSigningKey(header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signatureBytes = base64UrlDecode(parts[2]);
    const signatureBuffer = new ArrayBuffer(signatureBytes.byteLength);
    new Uint8Array(signatureBuffer).set(signatureBytes);

    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signatureBuffer,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return false;
  }
}

export function requireCronAuth(request: Request): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json(
      { ok: false, error: "cron_secret_not_configured" },
      { status: 401 },
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  return null;
}

export async function requireAutomationAuth(
  request: Request,
): Promise<NextResponse | null> {
  const authorization = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authorization === `Bearer ${cronSecret}`) {
    return null;
  }

  if (
    authorization?.startsWith("Bearer ") &&
    (await verifyGitHubOidcToken(authorization.slice("Bearer ".length)))
  ) {
    return null;
  }

  return NextResponse.json(
    {
      ok: false,
      error: cronSecret
        ? "Unauthorized"
        : "cron_secret_not_configured_and_github_oidc_invalid",
    },
    { status: 401 },
  );
}

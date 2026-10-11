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
  job_workflow_ref?: string;
};

type GitHubJwk = {
  kid?: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
};

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
    // Fail closed: only explicitly configured workflow files may use OIDC.
    // Values must exactly match the GitHub workflow_ref claim, including @ref.
    const allowedWorkflowRefs = (process.env.GITHUB_OIDC_ALLOWED_WORKFLOW_REFS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!claims.workflow_ref || allowedWorkflowRefs.length === 0) return false;
    if (!allowedWorkflowRefs.includes(claims.workflow_ref)) return false;

    // If a reusable workflow is in use, require its exact ref to be separately
    // allowlisted; never infer trust from a repository/path prefix.
    if (claims.job_workflow_ref) {
      const allowedJobWorkflowRefs = (process.env.GITHUB_OIDC_ALLOWED_JOB_WORKFLOW_REFS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (!allowedJobWorkflowRefs.includes(claims.job_workflow_ref)) return false;
    }

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

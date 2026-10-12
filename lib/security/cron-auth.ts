import "server-only";

import { NextResponse } from "next/server";
import { verifyGitHubOidcToken } from "./github-oidc-verifier";

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


/**
 * BASE audit endpoints accept the configured server secret or OIDC tokens
 * issued specifically to the production BASE audit workflow on main.
 * Keep the generic automation policy unchanged for unrelated cron jobs.
 */
export async function requireBaseAuditAuth(
  request: Request,
): Promise<NextResponse | null> {
  const authorization = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authorization === `Bearer ${cronSecret}`) {
    return null;
  }

  const expectedWorkflowRef =
    "shunai394-hash/tracer/.github/workflows/base-product-backup.yml@refs/heads/main";
  if (
    authorization?.startsWith("Bearer ") &&
    (await verifyGitHubOidcToken(
      authorization.slice("Bearer ".length),
      expectedWorkflowRef,
    ))
  ) {
    return null;
  }

  return NextResponse.json(
    {
      ok: false,
      error: cronSecret
        ? "Unauthorized"
        : "cron_secret_not_configured_and_base_audit_oidc_invalid",
    },
    { status: 401 },
  );
}

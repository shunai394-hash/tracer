import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Read-only SUPER DELIVERY source diagnostic.
 * TRACER uses the public product catalogue/search surface for discovery.
 * Private API credentials are intentionally not required.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  return NextResponse.json({
    ok: true,
    configured: true,
    source: "superdelivery_public_catalog",
    authenticationRequired: false,
    discovery: "JAN -> public product search -> product detail",
  });
}

import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * Marketplace-derived supplier investigation is disabled by policy.
 * Supplier sourcing must begin with supplier-native CJ product and variant data;
 * marketplace rankings are neither supplier inventory nor procurement evidence.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  return NextResponse.json({
    ok: true,
    skipped: true,
    job: "supplier-investigation",
    reason: "marketplace_sourcing_disabled_supplier_native_only",
  });
}

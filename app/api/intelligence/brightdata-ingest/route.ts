import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * Direct marketplace observation ingestion is disabled by policy.
 * TRACER sourcing must use supplier-native catalog and variant evidence.
 * Historical observations are retained; this endpoint performs no writes.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  return NextResponse.json({
    ok: true,
    skipped: true,
    reason: "marketplace_sourcing_disabled_supplier_native_only",
  });
}

import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 10;

/** Marketplace-based discovery is disabled; TRACER procurement uses supplier-native CJ evidence only. */
export async function POST(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;
  return NextResponse.json({
    ok: true,
    skipped: true,
    reason: "marketplace_sourcing_disabled_supplier_native_only",
  });
}

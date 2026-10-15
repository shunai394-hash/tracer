import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 10;

/** Out-of-scope workflow disabled: current operational scope is TRACER, BASE, and Shopify. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  return NextResponse.json({
    ok: true,
    skipped: true,
    reason: "newfind_out_of_scope_tracer_base_shopify_only",
  });
}

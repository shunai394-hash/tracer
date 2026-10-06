import { NextResponse } from "next/server";
import { repairCjMissingWomenVariants } from "@/lib/suppliers/repair-cj-variants";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    const result = await repairCjMissingWomenVariants({ limit: 50 });
    return NextResponse.json({ ok: true, job: "cj-variant-repair", ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, job: "cj-variant-repair", error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { verifyOpportunityLoopInvariants } from "@/lib/intelligence/build-opportunity-intelligence";

export const runtime = "nodejs";

export async function GET() {
  const invariants = verifyOpportunityLoopInvariants();

  return NextResponse.json({
    ok: invariants.ok,
    invariants,
  });
}

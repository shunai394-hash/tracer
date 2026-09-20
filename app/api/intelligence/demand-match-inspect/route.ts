import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = createSupabaseAdminClient();

    const { data, error } = await supabase
      .from("demand_product_matches")
      .select(`
        id,
        match_method,
        match_score,
        rationale,
        demand_observation_id,
        product_id,
        created_at,
        products (
          canonical_name
        ),
        demand_observations (
          value,
          metadata
        )
      `)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      ok: true,
      count: data?.length ?? 0,
      rows: data ?? [],
    });
  } catch (error) {
    console.error("[TRACER DEMAND MATCH INSPECT ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

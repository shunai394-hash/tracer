import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = createSupabaseAdminClient();

    const { data, error } = await supabase
      .from("demand_observations")
      .select("id, product_id, signal_type, value, observed_at, metadata")
      .order("observed_at", { ascending: false })
      .limit(1000);

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      ok: true,
      count: data?.length ?? 0,
      rows: data ?? [],
      productIdTypes: (data ?? []).map((row) => ({
        id: row.id,
        product_id: row.product_id,
        product_id_is_null: row.product_id === null,
      })),
    });
  } catch (error) {
    console.error("[TRACER DEMAND SCHEMA INSPECT ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}



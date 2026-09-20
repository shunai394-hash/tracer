import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = createSupabaseAdminClient();

    const { data, error } = await supabase
      .from("demand_observations")
      .select("id, value, signal_type, observed_at, metadata, product_id")
      .eq("signal_type", "search_volume")
      .order("observed_at", { ascending: false })
      .limit(10);

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      ok: true,
      count: data?.length ?? 0,
      rows: data ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

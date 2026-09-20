import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST() {
  try {
    const supabase = createSupabaseAdminClient();

    const { count, error } = await supabase
      .from("demand_product_matches")
      .delete({
        count: "exact",
      })
      .not("id", "is", null);

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      ok: true,
      deleted: count ?? 0,
    });
  } catch (error) {
    console.error("[TRACER DEMAND MATCH RESET ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

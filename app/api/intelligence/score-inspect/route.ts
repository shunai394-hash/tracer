import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = createSupabaseAdminClient();

    const { data: rows, error } = await supabase
      .from("product_intelligence")
      .select(`
        product_id,
        normalized_title,
        brand_name,
        current_price,
        demand_signal,
        opportunity_score
      `)
      .order("updated_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    const products = [];

    for (const row of rows ?? []) {
      const { count, error: offerError } = await supabase
        .from("product_offers")
        .select("id", { count: "exact", head: true })
        .eq("product_id", row.product_id);

      if (offerError) {
        throw new Error(offerError.message);
      }

      products.push({
        ...row,
        offer_count: count ?? 0,
      });
    }

    return NextResponse.json({
      ok: true,
      count: products.length,
      withOffers: products.filter((p) => p.offer_count > 0).length,
      withoutOffers: products.filter((p) => p.offer_count === 0).length,
      products,
    });
  } catch (error) {
    console.error("[TRACER SCORE INSPECT ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

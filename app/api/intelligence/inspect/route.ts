import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = createSupabaseAdminClient();

    const { data, error } = await supabase
      .from("product_intelligence")
      .select(`
        product_id,
        normalized_title,
        brand_name,
        seller_name,
        current_price,
        currency,
        identity_confidence,
        price_confidence,
        source_url,
        image_url
      `)
      .order("updated_at", { ascending: false })
      .limit(10);

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      ok: true,
      count: data?.length ?? 0,
      products: data ?? [],
    });
  } catch (error) {
    console.error("[TRACER INTELLIGENCE INSPECT ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

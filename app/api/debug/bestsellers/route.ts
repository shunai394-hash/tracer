import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";

export async function GET() {
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("marketplace_bestsellers")
    .select("id,marketplace,title,rank,asin,jan,gtin,ean,upc,mpn,product_url,product_id,fetched_at")
    .order("fetched_at", { ascending: false })
    .limit(BESTSELLER_CANDIDATE_BATCH_SIZE);

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    count: data?.length ?? 0,
    rows: data ?? [],
  });
}

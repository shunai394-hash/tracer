import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("tracer_new_products")
    .select("*")
    .order("published_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    category: "latest",
    products: data ?? [],
  });
}

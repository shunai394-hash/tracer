import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = createSupabaseAdminClient();

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .limit(20);

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      ok: true,
      count: data?.length ?? 0,
      products: data ?? [],
    });
  } catch (error) {
    console.error("[TRACER PRODUCT CATALOG INSPECT ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

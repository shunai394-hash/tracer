import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isBrokenText(value: string): boolean {
  return value.includes("\uFFFD");
}

export async function POST() {
  try {
    const supabase = createSupabaseAdminClient();

    const { data, error } = await supabase
      .from("demand_observations")
      .select("id, metadata")
      .eq("signal_type", "search_volume")
      .order("observed_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    let inspected = 0;
    let repaired = 0;
    let skipped = 0;

    for (const row of data ?? []) {
      inspected += 1;

      const metadata =
        row.metadata &&
        typeof row.metadata === "object" &&
        !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};

      const query =
        typeof metadata.query === "string"
          ? metadata.query
          : "";

      const originalQuery =
        typeof metadata.original_query === "string"
          ? metadata.original_query
          : "";

      /*
       * original_query が存在し、壊れていない場合は、
       * それを唯一の確実な復元元として使用する。
       *
       * query が � を含む場合だけでなく、
       * 0hMh のような別形式の文字化けにも対応する。
       */
      if (
        originalQuery &&
        !isBrokenText(originalQuery) &&
        query !== originalQuery
      ) {
        const { error: updateError } = await supabase
          .from("demand_observations")
          .update({
            metadata: {
              ...metadata,
              query: originalQuery,
              encoding_repaired: true,
              repair_method: "restore_original_query",
            },
          })
          .eq("id", row.id);

        if (updateError) {
          throw new Error(updateError.message);
        }

        repaired += 1;
        continue;
      }

      /*
       * original_query が無い、または original_query 自体が壊れている場合は
       * 推測による文字コード変換を行わない。
       */
      if (isBrokenText(query)) {
        skipped += 1;
      }
    }

    return NextResponse.json({
      ok: true,
      inspected,
      repaired,
      skipped,
    });
  } catch (error) {
    console.error("[TRACER DEMAND REPAIR ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

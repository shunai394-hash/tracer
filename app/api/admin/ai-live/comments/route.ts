import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { routeAiLiveComment } from "@/lib/ai-live/comment-router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Authenticated, read-only bridge for a livestream comment adapter.
 * Classifies one comment and, when a matching sale-ready product is supplied,
 * returns only current approved listing facts. It never reads customer orders,
 * calls an LLM, posts comments, or mutates commerce data.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ok: false, error: "invalid_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const input = body as Record<string, unknown>;
  if (typeof input.comment !== "string" || input.comment.length > 2000) {
    return NextResponse.json(
      { ok: false, error: "comment_must_be_string_under_2001_chars" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const route = routeAiLiveComment(input.comment);
  const productId = typeof input.productId === "string" && input.productId.length <= 128
    ? input.productId.trim()
    : "";

  if (!productId || route.action !== "answer_from_verified_facts") {
    return NextResponse.json(
      { ok: true, readOnly: true, route, productFacts: null },
      { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  }

  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db
      .from("shop_listings")
      .select("id,title,description,selling_price,currency,inventory,published,orderable,tracking_available,base_item_id,base_publication_status,archived_at")
      .eq("id", productId)
      .eq("published", true)
      .eq("orderable", true)
      .eq("tracking_available", true)
      .gt("inventory", 0)
      .is("archived_at", null)
      .not("base_item_id", "is", null)
      .eq("base_publication_status", "published")
      .maybeSingle();

    if (error) throw new Error(error.message);

    const row = data;
    const hasJapaneseText = (value: unknown): value is string =>
      typeof value === "string" && /[\u3040-\u30ff\u3400-\u9fff]/u.test(value);

    const productFacts = row &&
      hasJapaneseText(row.title) &&
      typeof row.selling_price === "number" &&
      Number.isFinite(row.selling_price) &&
      row.selling_price > 0 &&
      typeof row.inventory === "number" &&
      Number.isFinite(row.inventory) &&
      row.inventory > 0
      ? {
          id: String(row.id),
          title: row.title.trim(),
          description: hasJapaneseText(row.description) ? row.description.trim() : null,
          sellingPrice: row.selling_price,
          currency: typeof row.currency === "string" && row.currency.trim() ? row.currency : "JPY",
          inStock: true,
          productUrl: `https://tracer.base.ec/items/${encodeURIComponent(String(row.base_item_id))}`,
        }
      : null;

    return NextResponse.json(
      {
        ok: true,
        readOnly: true,
        route: productFacts ? route : {
          category: route.category,
          action: "human_handoff",
          reason: "no_verified_sale_ready_product",
        },
        productFacts,
      },
      { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "ai_live_comment_lookup_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

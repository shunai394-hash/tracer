import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { routeAiLiveComment } from "@/lib/ai-live/comment-router";
import { buildAiLiveReply } from "@/lib/ai-live/reply-from-facts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Authenticated, read-only bridge for a livestream comment adapter.
 * Returns a suggested spoken reply only when it can be built from current,
 * approved listing facts. It never reads customer orders, calls an LLM,
 * posts comments, or mutates commerce data.
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

  if (!body || typeof body !== "object" || Array.isArray(body)) {
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
    const safeRoute = !productId && route.action === "answer_from_verified_facts"
      ? { category: route.category, action: "human_handoff" as const, reason: "product_context_required" }
      : route;
    return NextResponse.json(
      { ok: true, readOnly: true, route: safeRoute, productFacts: null, suggestedReply: null },
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

    const reply = productFacts ? buildAiLiveReply(route.category, productFacts) : null;
    const responseRoute = !productFacts
      ? { category: route.category, action: "human_handoff" as const, reason: "no_verified_sale_ready_product" }
      : reply?.action === "human_handoff"
        ? { category: route.category, action: "human_handoff" as const, reason: reply.reason }
        : route;

    return NextResponse.json(
      {
        ok: true,
        readOnly: true,
        route: responseRoute,
        productFacts,
        suggestedReply: reply?.action === "speak_verified_reply" ? reply.text : null,
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

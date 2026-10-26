import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Read-only, minimized product feed for the local AI-live proof of concept.
 * This route intentionally exposes no supplier IDs, source costs, shipping
 * costs, margin/profit, credentials, order data, or internal gate diagnostics.
 * It never mutates listings or calls an external commerce API.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const requestedLimit = Number(new URL(request.url).searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(20, Math.max(1, Math.floor(requestedLimit)))
    : 10;

  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db
      .from("shop_listings")
      .select(
        "id,title,description,selling_price,currency,inventory,published,orderable,tracking_available,slug,base_item_id,base_publication_status,archived_at,updated_at",
      )
      .eq("published", true)
      .eq("orderable", true)
      .eq("tracking_available", true)
      .gt("inventory", 0)
      .is("archived_at", null)
      .not("base_item_id", "is", null)
      .eq("base_publication_status", "published")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);

    const hasJapaneseText = (value: unknown): value is string =>
      typeof value === "string" && /[\u3040-\u30ff\u3400-\u9fff]/u.test(value);

    const products = (data ?? [])
      .filter((row) =>
        hasJapaneseText(row.title) &&
        row.title.trim().length > 0 &&
        typeof row.selling_price === "number" &&
        Number.isFinite(row.selling_price) &&
        row.selling_price > 0 &&
        typeof row.inventory === "number" &&
        Number.isFinite(row.inventory) &&
        row.inventory > 0,
      )
      .map((row) => ({
        id: String(row.id),
        title: String(row.title).trim(),
        description: hasJapaneseText(row.description) ? row.description.trim() : null,
        sellingPrice: Number(row.selling_price),
        currency: typeof row.currency === "string" && row.currency.trim()
          ? row.currency
          : "JPY",
        inStock: true,
        productUrl:
          row.base_item_id && row.base_publication_status === "published"
            ? `https://tracer.base.ec/items/${encodeURIComponent(String(row.base_item_id))}`
            : null,
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
      }))
      .filter((row) => row.productUrl !== null);

    return NextResponse.json(
      {
        ok: true,
        readOnly: true,
        generatedAt: new Date().toISOString(),
        count: products.length,
        products,
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch {
    // Do not return database/provider errors to the caller.
    return NextResponse.json(
      { ok: false, error: "ai_live_product_read_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

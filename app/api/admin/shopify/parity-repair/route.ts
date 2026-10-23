import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOnlineStorePublicationId, shopifyGraphQL } from "@/lib/shopify/admin";
import { nextShopifyVendorPage, SHOPIFY_VENDOR_SCAN_MAX_PAGES } from "@/lib/shopify/catalog-scan";
import { legacyListingIdFromSku, planShopifyParityRepair, type ParityCommerceRow, type ParityLegacyRow, type ParityNode } from "@/lib/shopify/parity-repair-plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Drafts Shopify products that are live but not live in TRACER, matched by
 * product id or SKU only (see planShopifyParityRepair). Never deletes.
 *
 * POST { "apply": false } → dry-run plan with every product id and reason.
 * POST { "apply": true, "productIds": [...], "limit": 25 } → drafts only ids
 * that the fresh plan also marks "draft", reads the status back, and records
 * each attempt in commerce_events. Re-runs are no-ops: drafted products are no
 * longer live, so they drop out of the plan.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  let body: { apply?: unknown; productIds?: unknown; limit?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const apply = body.apply === true;
  const limit = Math.max(1, Math.min(25, Math.floor(Number(body.limit) || 25)));
  const requested = new Set(Array.isArray(body.productIds) ? body.productIds.map(String) : []);
  if (apply && requested.size === 0) {
    return NextResponse.json({ ok: false, error: "apply_requires_product_ids_from_dry_run" }, { status: 400 });
  }

  try {
    const publicationId = await getOnlineStorePublicationId();
    const nodes: ParityNode[] = [];
    let after: string | null = null;
    let scanComplete = false;
    for (let page = 0; page < SHOPIFY_VENDOR_SCAN_MAX_PAGES; page += 1) {
      let data: { products: { nodes: Array<Omit<ParityNode, "variants"> & { variants: { nodes: ParityNode["variants"] } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null = null;
      for (let attempt = 0; !data; attempt += 1) {
        try {
          data = await shopifyGraphQL(
            `query TracerParityProducts($after: String, $publicationId: ID!) {
              products(first: 100, after: $after, sortKey: ID, query: "vendor:TRACER") {
                nodes { id handle status vendor publishedOnPublication(publicationId: $publicationId) variants(first: 100) { nodes { id sku } } }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            { after, publicationId },
          );
        } catch (error) {
          if (attempt >= 5 || !/throttl/i.test(error instanceof Error ? error.message : String(error))) throw error;
          await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
        }
      }
      nodes.push(...data.products.nodes.map((node) => ({ ...node, variants: node.variants.nodes })));
      const step = nextShopifyVendorPage({
        pageIndex: page,
        maxPages: SHOPIFY_VENDOR_SCAN_MAX_PAGES,
        hasNextPage: data.products.pageInfo.hasNextPage,
        endCursor: data.products.pageInfo.endCursor,
        previousCursor: after,
      });
      if (step.action === "continue") {
        after = step.cursor;
        continue;
      }
      scanComplete = step.action === "complete";
      break;
    }
    // A partial scan could misread a product as unmatched; refuse to plan from it.
    if (!scanComplete) return NextResponse.json({ ok: false, error: "shopify_scan_incomplete" }, { status: 502 });

    const db = createSupabaseAdminClient();
    const commerceRows: ParityCommerceRow[] = [];
    for (let from = 0; ; from += 1000) {
      if (from >= 50_000) throw new Error("commerce_channel_scan_incomplete");
      const { data: page, error } = await db.from("channel_listings")
        .select("id,variant_id,external_product_id,external_sku,status,last_error")
        .eq("channel", "shopify")
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error("channel_listings_read_failed:" + error.message);
      commerceRows.push(...((page ?? []) as ParityCommerceRow[]));
      if ((page ?? []).length < 1000) break;
    }
    const legacyRows: ParityLegacyRow[] = [];
    for (let from = 0; ; from += 1000) {
      if (from >= 50_000) throw new Error("shop_listings_scan_incomplete");
      const { data: page, error } = await db.from("shop_listings")
        .select("id,published,shopify_product_id")
        .not("shopify_product_id", "is", null)
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error("shop_listings_read_failed:" + error.message);
      legacyRows.push(...((page ?? []) as ParityLegacyRow[]));
      if ((page ?? []).length < 1000) break;
    }
    // Legacy rows that lost their product id are still reachable by their TRC-<uuid> SKU.
    const known = new Set(legacyRows.map((row) => row.id.toLowerCase()));
    const skuIds = [...new Set(nodes.flatMap((node) => node.variants.map((v) => legacyListingIdFromSku(v.sku))).filter((id): id is string => Boolean(id) && !known.has(id!)))];
    for (let i = 0; i < skuIds.length; i += 200) {
      const { data, error } = await db.from("shop_listings").select("id,published,shopify_product_id").in("id", skuIds.slice(i, i + 200));
      if (error) throw new Error("shop_listings_sku_read_failed:" + error.message);
      legacyRows.push(...((data ?? []) as ParityLegacyRow[]));
    }

    const decisions = planShopifyParityRepair({ nodes, commerceRows, legacyRows });
    const drafts = decisions.filter((decision) => decision.action === "draft");
    const summary = {
      tracerProducts: nodes.length,
      live: decisions.length,
      keep: decisions.filter((d) => d.action === "keep").length,
      draft: drafts.length,
      manualReview: decisions.filter((d) => d.action === "manual_review").length,
    };
    const actionable = decisions.filter((decision) => decision.action !== "keep");
    if (!apply) {
      return NextResponse.json({ ok: true, readOnly: true, scanComplete, summary, actions: actionable }, { headers: { "Cache-Control": "no-store" } });
    }

    const selected = drafts.filter((decision) => requested.has(decision.shopifyProductId)).slice(0, limit);
    const skippedNotInPlan = [...requested].filter((id) => !drafts.some((d) => d.shopifyProductId === id));
    const results: Array<{ shopifyProductId: string; reason: string; ok: boolean; status: string | null; error: string | null }> = [];
    const day = new Date().toISOString().slice(0, 10);
    for (const decision of selected) {
      let status: string | null = null;
      let failure: string | null = null;
      try {
        const updated = await shopifyGraphQL<{ productUpdate: { product: { id: string; status: string } | null; userErrors: Array<{ message: string }> } }>(
          "mutation TracerParityDraft($input: ProductUpdateInput!) { productUpdate(product: $input) { product { id status } userErrors { message } } }",
          { input: { id: decision.shopifyProductId, status: "DRAFT" } },
        );
        if (updated.productUpdate.userErrors.length || !updated.productUpdate.product) {
          throw new Error("shopify_draft_failed:" + (updated.productUpdate.userErrors.map((e) => e.message).join("; ") || "product_missing"));
        }
        const readback = await shopifyGraphQL<{ product: { status: string } | null }>(
          "query TracerParityReadback($id: ID!) { product(id: $id) { status } }",
          { id: decision.shopifyProductId },
        );
        status = readback.product?.status ?? null;
        if (status !== "DRAFT") throw new Error("shopify_draft_readback_mismatch:status=" + String(status));
      } catch (error) {
        failure = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      }
      results.push({ shopifyProductId: decision.shopifyProductId, reason: decision.reason, ok: !failure, status, error: failure });
      const { error: logError } = await db.from("commerce_events").upsert({
        event_key: "shopify_parity_draft:" + decision.shopifyProductId.split("/").pop() + ":" + day + (failure ? ":error" : ""),
        event_type: "shopify_parity_draft",
        entity_type: "shopify_product",
        entity_id: decision.shopifyProductId,
        status: failure ? "error" : "ok",
        detail: { ...decision, readbackStatus: status, error: failure },
      }, { onConflict: "event_key", ignoreDuplicates: true });
      if (logError) results[results.length - 1].error = (failure ? failure + "; " : "") + "event_log_failed:" + logError.message.slice(0, 80);
    }
    const failed = results.filter((r) => !r.ok).length;
    return NextResponse.json({
      ok: failed === 0,
      readOnly: false,
      summary,
      selected: selected.length,
      draftedAndVerified: results.filter((r) => r.ok).length,
      failed,
      remaining: drafts.length - results.filter((r) => r.ok).length,
      skippedNotInPlan,
      results,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 400) : String(error) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createBaseItem, editBaseItem, addBaseItemImage, isBaseConfigured } from "@/lib/channels/base";
import { hasPassedSalesTestGate, SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";
import { generateStructuredJson, isGeminiConfigured } from "@/lib/ai/gemini/client";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";

export type BasePublicationResult = {
  attempted: number;
  published: number;
  skipped: number;
  failed: number;
  results: Array<{ listingId: string; ok: boolean; baseItemId?: string | null; skipped?: boolean; error?: string }>;
};

type JapaneseCatalogCopy = { title: string; detail: string; };

async function ensureJapaneseCatalogCopy(title: string, detail: string): Promise<JapaneseCatalogCopy> {
  const sourceTitle = String(title ?? "").trim();
  const sourceDetail = String(detail ?? "").trim();
  if (isJapaneseProductTitle(sourceTitle) && /[ぁ-んァ-ヶ一-龯々〆ヵー]/.test(sourceDetail)) return { title: sourceTitle, detail: sourceDetail };
  if (!isGeminiConfigured()) throw new Error("BASE japanese catalog copy requires GEMINI_API_KEY");
  const result = await generateStructuredJson<JapaneseCatalogCopy>({
    systemInstruction: "あなたは日本のEC商品編集者です。入力された商品情報を日本語の販売用コピーへ変換してください。商品名と説明は必ず日本語にしてください。英語の固有名詞・型番・規格・ブランド名は必要な場合だけ残してください。存在しない仕様や数値を追加しないでください。titleは簡潔で自然な日本語の商品名、detailは購入判断に必要な特徴を読みやすい日本語でまとめてください。JSONのみ返してください。",
    prompt: JSON.stringify({ title: sourceTitle, detail: sourceDetail }),
    timeoutMs: 12_000,
  });
  const translatedTitle = String(result?.title ?? "").trim();
  const translatedDetail = String(result?.detail ?? "").trim();
  if (!isJapaneseProductTitle(translatedTitle)) throw new Error("BASE japanese catalog copy returned a non-Japanese title");
  if (!translatedDetail || !/[ぁ-んァ-ヶ一-龯々〆ヵー]/.test(translatedDetail)) throw new Error("BASE japanese catalog copy returned a non-Japanese description");
  return { title: translatedTitle, detail: translatedDetail };
}

function validHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try { const parsed = new URL(value); return parsed.protocol === "http:" || parsed.protocol === "https:"; } catch { return false; }
}

export async function publishPublishedListingsToBase(limit = 10, listingIds?: string[]): Promise<BasePublicationResult> {
  if (!isBaseConfigured()) return { attempted: 0, published: 0, skipped: 0, failed: 0, results: [] };
  if (listingIds !== undefined && listingIds.length === 0) return { attempted: 0, published: 0, skipped: 0, failed: 0, results: [] };
  const supabase = createSupabaseAdminClient();
  let query = supabase.from("shop_listings").select("id,title,description,selling_price,image_url,published,base_item_id,base_publication_status,base_publication_lease_until,inventory,orderable,tracking_available,shipping_cost,supplier_name,supplier_listing_id,supplier_product_id,supplier_variant_id,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons").or("published.eq.true,base_item_id.not.is.null,pipeline_status.eq.selected");
  if (listingIds && listingIds.length > 0) query = query.in("id", Array.from(new Set(listingIds)));
  const { data: listings, error } = await query.order("base_item_id", { ascending: true, nullsFirst: true }).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);

  const results: BasePublicationResult["results"] = [];
  for (const listing of listings ?? []) {
    const listingId = String(listing.id);
    let catalogCopy: JapaneseCatalogCopy;
    try {
      catalogCopy = await ensureJapaneseCatalogCopy(String(listing.title ?? ""), String(listing.description ?? listing.title ?? ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase.from("shop_listings").update({
        base_last_error: message,
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: "japanese_catalog_copy_required",
        pipeline_error: message,
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "japanese_catalog_copy_required" });
      continue;
    }
    if (catalogCopy.title !== String(listing.title ?? "").trim() || catalogCopy.detail !== String(listing.description ?? listing.title ?? "").trim()) {
      await supabase.from("shop_listings").update({ title: catalogCopy.title, description: catalogCopy.detail, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
    }
    const hasSelectedGate = listing.pipeline_status === "selected"
      && listing.pipeline_reason === SALES_TEST_GATE_PASSED
      && Array.isArray(listing.selection_reasons)
      && listing.selection_reasons.includes(SALES_TEST_GATE_PASSED);
    const hasSalesTestGate = hasPassedSalesTestGate({ ...listing, title: catalogCopy.title, normalized_title: catalogCopy.title }) || hasSelectedGate;

    if (listing.base_item_id && listing.published !== true) {
      if (listing.selling_price === null) { results.push({ listingId, ok: false, skipped: true, error: "base_hide_price_unknown" }); continue; }
      try {
        await editBaseItem({ itemId: String(listing.base_item_id), title: catalogCopy.title, detail: catalogCopy.detail, price: Number(listing.selling_price), stock: 0, visible: false });
        await supabase.from("shop_listings").update({ base_publication_status: "published", base_publication_lease_until: null, base_last_error: null, pipeline_stage: "BASE_RECONCILED", pipeline_status: "blocked", pipeline_reason: "tracer_unpublished", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
        results.push({ listingId, ok: true, baseItemId: String(listing.base_item_id) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await supabase.from("shop_listings").update({ base_last_error: message, pipeline_stage: "BASE_RECONCILIATION", pipeline_status: "failed", pipeline_reason: "base_hide_failed", pipeline_error: message, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
        results.push({ listingId, ok: false, error: message });
      }
      continue;
    }

    if (!listing.base_item_id && !hasSalesTestGate) { results.push({ listingId, ok: false, skipped: true, error: "sales_test_gate_not_passed" }); continue; }

    // BASE publication is a sales-channel operation, not procurement authorization.
    // A listing may be sold on BASE only when the canonical Sales Test Gate has
    // passed and the currently observed supply is sellable. Automatic purchasing
    // is evaluated separately at order time; it must never suppress a valid
    // storefront listing here.
    if (listing.tracking_available !== true) {
      await supabase.from("shop_listings").update({
        published: false,
        orderable: false,
        base_publication_status: listing.base_item_id ? "published" : "blocked",
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: "tracking_unavailable",
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      if (listing.base_item_id) {
        try {
          await editBaseItem({ itemId: String(listing.base_item_id), title: catalogCopy.title, detail: catalogCopy.detail, price: Number(listing.selling_price ?? 0), stock: 0, visible: false });
        } catch (error) {
          results.push({ listingId, ok: false, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      results.push({ listingId, ok: false, skipped: true, error: "tracking_unavailable" });
      continue;
    }

    if (!listing.supplier_product_id || !listing.supplier_variant_id) {
      await supabase.from("shop_listings").update({
        published: false,
        orderable: false,
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: "supplier_variant_identity_missing",
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "supplier_variant_identity_missing" });
      continue;
    }

    const price = Number(listing.selling_price);
    if (!Number.isFinite(price) || price <= 0) {
      await supabase.from("shop_listings").update({ pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: "selling_price_invalid", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "selling_price_invalid" });
      continue;
    }

    if (!validHttpUrl(listing.image_url)) {
      await supabase.from("shop_listings").update({ pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: "image_url_invalid", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "image_url_invalid" });
      continue;
    }

    const shippingCost = listing.shipping_cost === null || listing.shipping_cost === undefined ? null : Number(listing.shipping_cost);
    if (shippingCost === null || !Number.isFinite(shippingCost) || shippingCost <= 0) {
      if (listing.base_item_id) {
        try { await editBaseItem({ itemId: String(listing.base_item_id), title: catalogCopy.title, detail: catalogCopy.detail, price, stock: 0, visible: false }); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await supabase.from("shop_listings").update({ base_last_error: message, pipeline_stage: "BASE_RECONCILIATION", pipeline_status: "failed", pipeline_reason: "base_hide_shipping_unknown_failed", pipeline_error: message, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
          results.push({ listingId, ok: false, error: message }); continue;
        }
      }
      await supabase.from("shop_listings").update({ published: false, base_publication_status: listing.base_item_id ? "published" : "blocked", base_publication_lease_until: null, pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: shippingCost === null ? "shipping_unknown" : "shipping_invalid", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: shippingCost === null ? "shipping_unknown" : "shipping_invalid" }); continue;
    }

    const availableInventory = typeof listing.inventory === "number" ? Math.floor(listing.inventory) : typeof listing.inventory === "string" && listing.inventory.trim() !== "" ? Math.floor(Number(listing.inventory)) : null;
    if (availableInventory === null || !Number.isFinite(availableInventory) || availableInventory <= 0 || listing.orderable !== true) {
      if (listing.base_item_id) {
        try { await editBaseItem({ itemId: String(listing.base_item_id), title: catalogCopy.title, detail: catalogCopy.detail, price, stock: 0, visible: false }); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await supabase.from("shop_listings").update({ base_last_error: message, pipeline_stage: "BASE_RECONCILIATION", pipeline_status: "failed", pipeline_reason: "base_hide_failed", pipeline_error: message, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
          results.push({ listingId, ok: false, error: message }); continue;
        }
      }
      await supabase.from("shop_listings").update({ pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: availableInventory === null || !Number.isFinite(availableInventory) ? "inventory_unknown" : availableInventory <= 0 ? "inventory_zero" : "supplier_not_orderable", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: availableInventory === null || !Number.isFinite(availableInventory) ? "inventory_unknown" : availableInventory <= 0 ? "inventory_zero" : "supplier_not_orderable" }); continue;
    }

    const leaseUntil = new Date(Date.now() + 2 * 60_000).toISOString();

    // Claim a new BASE publication atomically before creating the remote item.
    // This prevents overlapping cron invocations from creating duplicate BASE
    // products for the same TRACER listing.
    if (!listing.base_item_id) {
      const { data: claimed, error: claimError } = await supabase
        .from("shop_listings")
        .update({
          base_publication_status: "creating",
          base_publication_lease_until: leaseUntil,
          pipeline_stage: "BASE_PUBLICATION",
          pipeline_status: "publishing",
          pipeline_reason: "sales_test_gate_passed",
          pipeline_updated_at: new Date().toISOString(),
        })
        .eq("id", listingId)
        .or("published.eq.true,pipeline_status.eq.selected")
        .or("base_publication_status.is.null,base_publication_status.eq.failed,base_publication_status.eq.creating")
        .or("base_publication_lease_until.is.null,base_publication_lease_until.lt." + new Date().toISOString())
        .select("id")
        .maybeSingle();
      if (claimError) throw new Error(claimError.message);
      if (!claimed) {
        results.push({ listingId, ok: false, skipped: true, error: "base_publication_claim_lost" });
        continue;
      }
    }

    try {
      let baseItemId = listing.base_item_id ? String(listing.base_item_id) : null;
      if (baseItemId) {
        await editBaseItem({ itemId: baseItemId, title: catalogCopy.title, detail: catalogCopy.detail, price, stock: availableInventory, visible: true });
      } else {
        const created = await createBaseItem({ title: catalogCopy.title, detail: catalogCopy.detail, price, stock: availableInventory, visible: true });
        baseItemId = String(created.item_id ?? created.item?.item_id ?? "");
        if (!baseItemId) throw new Error("BASE create response missing item_id");
        const { error: persistIdError } = await supabase.from("shop_listings").update({ base_item_id: baseItemId, base_publication_status: "creating", base_publication_lease_until: leaseUntil }).eq("id", listingId);
        if (persistIdError) throw new Error(persistIdError.message);
      }
      if (listing.image_url) await addBaseItemImage({ itemId: baseItemId, imageNo: 1, imageUrl: listing.image_url });
      await supabase.from("shop_listings").update({ base_item_id: baseItemId, base_published_at: new Date().toISOString(), base_publication_status: "published", base_publication_lease_until: null, base_last_error: null, pipeline_stage: "BASE_PUBLISHED", pipeline_status: "published", pipeline_reason: "sales_test_gate_passed", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: true, baseItemId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase.from("shop_listings").update({ base_last_error: message, pipeline_stage: "BASE_PUBLICATION", pipeline_status: "failed", pipeline_reason: "base_publish_failed", pipeline_error: message, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, error: message });
    }
  }
  return { attempted: listings?.length ?? 0, published: results.filter((r) => r.ok && r.baseItemId).length, skipped: results.filter((r) => r.skipped).length, failed: results.filter((r) => !r.ok && !r.skipped).length, results };
}

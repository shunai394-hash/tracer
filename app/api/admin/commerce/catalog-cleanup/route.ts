import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncCommerceListings } from "@/lib/commerce/publish";
import { editBaseItem, getBaseItemDetail } from "@/lib/channels/base";
import { shopifyGraphQL, toShopifyGid } from "@/lib/shopify/admin";
import { sendNewfindProductWithdrawnForUrls, withdrawNewfindPromotionsForVariants } from "@/lib/integration/newfind-commerce";
import { applyManualTitle, normalizeListingTitle } from "@/lib/commerce/listing-title";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Channel = "shopify" | "base";
type Ref = { channel: Channel; externalProductId: string };
type CopyItem = { ref: Ref; title?: string; description?: string };
type ListingRow = { id: string; variant_id: string; channel: Channel; external_product_id: string | null; status: string; selling_price: number; published_url: string | null };

type LegacyRow = { id: string; title: string | null; description: string | null; selling_price: number | null; shopify_product_id: string | null; shopify_handle: string | null; base_item_id: string | null; archived_at: string | null };

const MAX_REFS_PER_CALL = 15;

async function hideShopifyProduct(rawId: string): Promise<void> {
  const gid = toShopifyGid("Product", rawId);
  if (!gid) throw new Error("shopify_product_id_invalid");
  const updated = await shopifyGraphQL<{ productUpdate: { product: { status: string } | null; userErrors: Array<{ message: string }> } }>(
    "mutation TracerManualWithdraw($input: ProductUpdateInput!) { productUpdate(product: $input) { product { status } userErrors { message } } }",
    { input: { id: gid, status: "DRAFT" } },
  );
  if (updated.productUpdate.userErrors.length || updated.productUpdate.product?.status !== "DRAFT") {
    throw new Error("shopify_draft_failed:" + updated.productUpdate.userErrors.map((e) => e.message).join("; "));
  }
}

// BASE edits replace every field, so read the live item first and keep what we
// are not changing (visibility and stock unless hiding).
async function editBaseKeeping(itemId: string, change: { title?: string; detail?: string; hide?: boolean }, fallbackPrice: number): Promise<void> {
  const live = await getBaseItemDetail(itemId);
  const visible = change.hide ? false : !(live.visible === false || live.visible === 0 || live.visible === "0");
  await editBaseItem({
    itemId,
    title: change.title ?? String(live.title ?? "TRACER商品"),
    detail: change.detail ?? String(live.detail ?? live.title ?? "TRACER商品"),
    price: Math.max(50, Math.round(Number(live.price) || fallbackPrice || 50)),
    stock: change.hide ? 0 : Math.max(0, Math.floor(Number(live.stock) || 0)),
    visible,
  });
}

async function retitleShopifyProduct(rawId: string, title: string, descriptionHtml?: string): Promise<void> {
  const gid = toShopifyGid("Product", rawId);
  if (!gid) throw new Error("shopify_product_id_invalid");
  const input: Record<string, unknown> = { id: gid, title };
  if (descriptionHtml) input.descriptionHtml = descriptionHtml;
  const updated = await shopifyGraphQL<{ productUpdate: { product: { title: string } | null; userErrors: Array<{ message: string }> } }>(
    "mutation TracerManualRetitle($input: ProductUpdateInput!) { productUpdate(product: $input) { product { title } userErrors { message } } }",
    { input },
  );
  if (updated.productUpdate.userErrors.length || !updated.productUpdate.product) {
    throw new Error("shopify_retitle_failed:" + updated.productUpdate.userErrors.map((e) => e.message).join("; "));
  }
}
const WITHDRAW_REASON = "manual_catalog_cleanup";

function parseRef(value: unknown): Ref | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const channel = raw.channel === "shopify" || raw.channel === "base" ? raw.channel : null;
  const id = typeof raw.externalProductId === "string" || typeof raw.externalProductId === "number"
    ? String(raw.externalProductId).trim() : "";
  return channel && /^[0-9A-Za-z/:._-]{1,80}$/.test(id) ? { channel, externalProductId: id } : null;
}

// Shopify listings are stored as product GIDs; BASE as numeric item IDs.
function storedIdCandidates(ref: Ref): string[] {
  if (ref.channel === "base") return [ref.externalProductId];
  const numeric = ref.externalProductId.match(/(\d+)$/)?.[1] ?? ref.externalProductId;
  return [...new Set([ref.externalProductId, numeric, toShopifyGid("Product", numeric) ?? ""].filter(Boolean))];
}

/**
 * Explicit, bounded catalog cleanup keyed by storefront IDs.
 * POST { apply:false, withdraw, copy, resync } → resolves each Shopify/BASE ID to its
 * canonical product and reports what would change (read-only).
 * POST { apply:true, ... } → withdraws products (inactive in the DB, hidden on
 * Shopify/BASE, NEWFIND promotion withdrawn), saves curated copy as
 * metadata.manualTitleJa / manualDescriptionJa, and re-syncs affected variants so
 * all storefronts show the same corrected listing. Never deletes anything.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const apply = body.apply === true;
  const withdraw = (Array.isArray(body.withdraw) ? body.withdraw : []).map(parseRef);
  const resync = (Array.isArray(body.resync) ? body.resync : []).map(parseRef);
  const copyRaw = Array.isArray(body.copy) ? body.copy : [];
  const copy: Array<CopyItem | null> = copyRaw.map((item) => {
    const ref = parseRef((item as Record<string, unknown>)?.ref);
    if (!ref) return null;
    const title = typeof (item as Record<string, unknown>).title === "string" ? String((item as Record<string, unknown>).title).trim() : undefined;
    const description = typeof (item as Record<string, unknown>).description === "string" ? String((item as Record<string, unknown>).description).trim() : undefined;
    return { ref, title, description };
  });
  if ([...withdraw, ...resync, ...copy].some((item) => item === null)) {
    return NextResponse.json({ ok: false, error: "invalid_ref" }, { status: 400 });
  }
  const refs = [...withdraw, ...resync, ...copy.map((item) => item!.ref)] as Ref[];
  if (refs.length === 0) return NextResponse.json({ ok: false, error: "nothing_requested" }, { status: 400 });
  if (apply && refs.length > MAX_REFS_PER_CALL) {
    return NextResponse.json({ ok: false, error: "too_many_refs_per_apply", max: MAX_REFS_PER_CALL }, { status: 400 });
  }
  for (const item of copy) {
    if (item?.title !== undefined) {
      const preview = applyManualTitle(item.title, "");
      if (!preview || !isJapaneseProductTitle(preview) || !isPublishableCatalogTitle(preview) || preview.length > 120) {
        return NextResponse.json({ ok: false, error: "manual_title_not_publishable", title: item.title }, { status: 400 });
      }
    }
    if (item?.description !== undefined && (item.description.length < 20 || item.description.length > 3000)) {
      return NextResponse.json({ ok: false, error: "manual_description_length_invalid" }, { status: 400 });
    }
  }

  const db = createSupabaseAdminClient();

  // Resolve storefront IDs → listings → variants → products.
  const resolved = new Map<string, { variantId: string; productId: string }>();
  const unresolved: Ref[] = [];
  for (const ref of refs) {
    const key = ref.channel + ":" + ref.externalProductId;
    if (resolved.has(key)) continue;
    const { data: listing, error } = await db.from("channel_listings")
      .select("variant_id")
      .eq("channel", ref.channel)
      .in("external_product_id", storedIdCandidates(ref))
      .limit(1)
      .maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: "listing_read_failed", detail: error.message }, { status: 500 });
    if (!listing?.variant_id) { unresolved.push(ref); continue; }
    const { data: variant, error: variantError } = await db.from("commerce_variants")
      .select("id,product_id").eq("id", listing.variant_id).maybeSingle();
    if (variantError) return NextResponse.json({ ok: false, error: "variant_read_failed", detail: variantError.message }, { status: 500 });
    if (!variant?.product_id) { unresolved.push(ref); continue; }
    resolved.set(key, { variantId: String(variant.id), productId: String(variant.product_id) });
  }
  // Older listings live in shop_listings and are synced by the legacy jobs.
  const legacy = new Map<string, LegacyRow>();
  const stillUnresolved: Ref[] = [];
  for (const ref of unresolved) {
    const column = ref.channel === "shopify" ? "shopify_product_id" : "base_item_id";
    const { data, error } = await db.from("shop_listings")
      .select("id,title,description,selling_price,shopify_product_id,shopify_handle,base_item_id,archived_at")
      .in(column, storedIdCandidates(ref))
      .limit(1)
      .maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: "legacy_listing_read_failed", detail: error.message }, { status: 500 });
    if (data) legacy.set(ref.channel + ":" + ref.externalProductId, data as LegacyRow);
    else stillUnresolved.push(ref);
  }
  unresolved.length = 0;
  unresolved.push(...stillUnresolved);
  const legacyOf = (ref: Ref | null) => (ref ? legacy.get(ref.channel + ":" + ref.externalProductId) : undefined);
  const legacyWithdraw = new Map<string, LegacyRow>();
  for (const ref of withdraw) { const row = legacyOf(ref); if (row) legacyWithdraw.set(row.id, row); }
  const legacyRetitle = new Map<string, { row: LegacyRow; title: string; description?: string }>();
  for (const ref of resync) {
    const row = legacyOf(ref);
    if (!row || legacyWithdraw.has(row.id)) continue;
    const next = normalizeListingTitle(row.title);
    if (next && next !== String(row.title ?? "").trim() && isJapaneseProductTitle(next) && isPublishableCatalogTitle(next)) legacyRetitle.set(row.id, { row, title: next });
  }
  for (const item of copy) {
    const row = legacyOf(item!.ref);
    if (!row || legacyWithdraw.has(row.id)) continue;
    const title = item!.title ? applyManualTitle(item!.title, row.title) : String(row.title ?? "");
    legacyRetitle.set(row.id, { row, title, description: item!.description });
  }

  const productOf = (ref: Ref | null) => (ref ? resolved.get(ref.channel + ":" + ref.externalProductId)?.productId : undefined);

  const productIds = [...new Set([...resolved.values()].map((item) => item.productId))];
  const { data: products, error: productError } = productIds.length
    ? await db.from("commerce_products").select("id,title_ja,active,metadata").in("id", productIds)
    : { data: [], error: null };
  if (productError) return NextResponse.json({ ok: false, error: "product_read_failed", detail: productError.message }, { status: 500 });
  const { data: variants, error: variantsError } = productIds.length
    ? await db.from("commerce_variants").select("id,product_id").in("product_id", productIds)
    : { data: [], error: null };
  if (variantsError) return NextResponse.json({ ok: false, error: "variants_read_failed", detail: variantsError.message }, { status: 500 });
  const variantsByProduct = new Map<string, string[]>();
  for (const row of variants ?? []) {
    const list = variantsByProduct.get(String(row.product_id)) ?? [];
    list.push(String(row.id));
    variantsByProduct.set(String(row.product_id), list);
  }

  // Withdrawal is product-level. A product that also carries variants nobody
  // asked to withdraw (e.g. the correctly priced twin) is skipped, not withdrawn.
  const requestedVariantIds = new Set(withdraw.map((ref) => resolved.get(ref!.channel + ":" + ref!.externalProductId)?.variantId).filter(Boolean));
  const withdrawCandidates = [...new Set(withdraw.map(productOf).filter((id): id is string => Boolean(id)))];
  const skippedMultiVariant = withdrawCandidates.filter((id) => (variantsByProduct.get(id) ?? []).some((variantId) => !requestedVariantIds.has(variantId)));
  const withdrawProducts = withdrawCandidates.filter((id) => !skippedMultiVariant.includes(id));
  const copyProducts = new Map<string, CopyItem>();
  for (const item of copy) {
    const productId = productOf(item!.ref);
    if (productId && !withdrawProducts.includes(productId)) copyProducts.set(productId, item!);
  }
  const resyncProducts = [...new Set([
    ...resync.map(productOf).filter((id): id is string => Boolean(id)),
    ...copyProducts.keys(),
  ])].filter((id) => !withdrawProducts.includes(id));

  const plan = {
    withdraw: withdrawProducts.map((id) => ({ productId: id, title: (products ?? []).find((p) => p.id === id)?.title_ja ?? null, variants: variantsByProduct.get(id)?.length ?? 0 })),
    copy: [...copyProducts.entries()].map(([id, item]) => ({ productId: id, from: (products ?? []).find((p) => p.id === id)?.title_ja ?? null, title: item.title ?? null, description: Boolean(item.description) })),
    resync: resyncProducts.map((id) => ({ productId: id, title: (products ?? []).find((p) => p.id === id)?.title_ja ?? null })),
    skippedMultiVariant,
    legacyWithdraw: [...legacyWithdraw.values()].map((row) => ({ listingId: row.id, title: row.title, archived: Boolean(row.archived_at) })),
    legacyRetitle: [...legacyRetitle.values()].map((item) => ({ listingId: item.row.id, from: item.row.title, to: item.title })),
    unresolved,
  };
  if (!apply) return NextResponse.json({ ok: true, readOnly: true, plan });

  const now = new Date().toISOString();
  const errors: string[] = [];

  // 1) Withdraw: inactive in the DB first so no sync can republish it.
  const withdrawnVariantIds: string[] = [];
  for (const productId of withdrawProducts) {
    const product = (products ?? []).find((p) => p.id === productId);
    const metadata = { ...((product?.metadata as Record<string, unknown> | null) ?? {}), manualWithdrawal: { reason: WITHDRAW_REASON, at: now } };
    const { error } = await db.from("commerce_products").update({ active: false, metadata, updated_at: now }).eq("id", productId);
    if (error) { errors.push(productId + ":deactivate_failed:" + error.message); continue; }
    withdrawnVariantIds.push(...(variantsByProduct.get(productId) ?? []));
  }
  const hidden = { shopify: 0, base: 0 };
  // Storefront URLs NEWFIND may link to for anything withdrawn here.
  const withdrawnUrls: string[] = [];
  if (withdrawnVariantIds.length) {
    const { data: listings, error } = await db.from("channel_listings")
      .select("id,variant_id,channel,external_product_id,status,selling_price,published_url")
      .in("variant_id", withdrawnVariantIds);
    if (error) errors.push("withdraw_listing_read_failed:" + error.message);
    const hiddenShopifyProducts = new Set<string>();
    for (const listing of (listings ?? []) as ListingRow[]) {
      if (listing.published_url) withdrawnUrls.push(String(listing.published_url));
      if (!listing.external_product_id) continue;
      try {
        if (listing.channel === "shopify") {
          const gid = toShopifyGid("Product", String(listing.external_product_id));
          if (gid && !hiddenShopifyProducts.has(gid)) {
            const updated = await shopifyGraphQL<{ productUpdate: { product: { status: string } | null; userErrors: Array<{ message: string }> } }>(
              "mutation TracerManualWithdraw($input: ProductUpdateInput!) { productUpdate(product: $input) { product { status } userErrors { message } } }",
              { input: { id: gid, status: "DRAFT" } },
            );
            if (updated.productUpdate.userErrors.length || updated.productUpdate.product?.status !== "DRAFT") {
              throw new Error("shopify_draft_failed:" + updated.productUpdate.userErrors.map((e) => e.message).join("; "));
            }
            hiddenShopifyProducts.add(gid);
            hidden.shopify++;
          }
        } else {
          const itemId = String(listing.external_product_id);
          const detail = await getBaseItemDetail(itemId);
          await editBaseItem({
            itemId,
            title: String(detail.title ?? "TRACER商品"),
            detail: String(detail.detail ?? detail.title ?? "TRACER商品"),
            price: Math.max(50, Math.round(Number(detail.price) || Number(listing.selling_price) || 50)),
            stock: 0,
            visible: false,
          });
          hidden.base++;
        }
        const { error: saveError } = await db.from("channel_listings")
          .update({ status: "hidden", last_error: WITHDRAW_REASON, last_synced_at: now, updated_at: now })
          .eq("id", listing.id);
        if (saveError) errors.push(listing.id + ":listing_state_save_failed:" + saveError.message);
      } catch (error) {
        errors.push(listing.id + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 160));
      }
    }
  }
  let newfind: Awaited<ReturnType<typeof withdrawNewfindPromotionsForVariants>> | { error: string } | null = null;
  if (withdrawnVariantIds.length) {
    try {
      newfind = await withdrawNewfindPromotionsForVariants(withdrawnVariantIds, WITHDRAW_REASON);
    } catch (error) {
      newfind = { error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) };
    }
  }

  // 1b) Legacy listings: archive (excluded from every legacy sync) and hide.
  const legacyResult = { archived: 0, retitled: 0 };
  for (const row of legacyWithdraw.values()) {
    try {
      const { error } = await db.from("shop_listings").update({
        published: false, published_at: null, archived_at: now, archive_reason: WITHDRAW_REASON, updated_at: now,
      }).eq("id", row.id);
      if (error) throw new Error("legacy_archive_failed:" + error.message);
      const shopDomain = process.env.SHOPIFY_STORE_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
      if (row.shopify_handle && shopDomain) withdrawnUrls.push(`https://${shopDomain}/products/${encodeURIComponent(String(row.shopify_handle))}`);
      if (row.shopify_product_id) { await hideShopifyProduct(String(row.shopify_product_id)); hidden.shopify++; }
      if (row.base_item_id) { await editBaseKeeping(String(row.base_item_id), { hide: true }, Number(row.selling_price) || 50); hidden.base++; }
      legacyResult.archived++;
    } catch (error) {
      errors.push("legacy:" + row.id + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 160));
    }
  }
  for (const { row, title, description } of legacyRetitle.values()) {
    try {
      const update: Record<string, unknown> = { title, updated_at: now };
      if (description) update.description = description;
      const { error } = await db.from("shop_listings").update(update).eq("id", row.id);
      if (error) throw new Error("legacy_title_save_failed:" + error.message);
      if (row.shopify_product_id) await retitleShopifyProduct(String(row.shopify_product_id), title);
      if (row.base_item_id) await editBaseKeeping(String(row.base_item_id), { title, ...(description ? { detail: description } : {}) }, Number(row.selling_price) || 50);
      legacyResult.retitled++;
    } catch (error) {
      errors.push("legacy:" + row.id + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 160));
    }
  }

  let newfindUrls: { sent: boolean; status: string; urls: number } | null = null;
  if (withdrawnUrls.length) {
    try {
      const sent = await sendNewfindProductWithdrawnForUrls(withdrawnUrls, WITHDRAW_REASON);
      newfindUrls = { ...sent, urls: new Set(withdrawnUrls).size };
      if (!sent.sent && sent.status !== "newfind_not_configured") errors.push("newfind_url_withdraw:" + sent.status);
    } catch (error) {
      errors.push("newfind_url_withdraw:" + (error instanceof Error ? error.message : String(error)).slice(0, 160));
    }
  }

  // 2) Curated copy, stored where every sync reads it first.
  for (const [productId, item] of copyProducts) {
    const product = (products ?? []).find((p) => p.id === productId);
    const metadata: Record<string, unknown> = { ...((product?.metadata as Record<string, unknown> | null) ?? {}) };
    if (item.title) metadata.manualTitleJa = item.title;
    if (item.description) metadata.manualDescriptionJa = item.description;
    metadata.manualCopyUpdatedAt = now;
    const { error } = await db.from("commerce_products").update({ metadata, updated_at: now }).eq("id", productId);
    if (error) errors.push(productId + ":manual_copy_save_failed:" + error.message);
  }

  // 3) Push corrected listings to both storefronts.
  const resyncVariantIds = resyncProducts.flatMap((id) => variantsByProduct.get(id) ?? []);
  let sync: Record<Channel, unknown> | null = null;
  if (resyncVariantIds.length) {
    const [shopify, base] = await Promise.all([
      syncCommerceListings("shopify", resyncVariantIds.length, false, resyncVariantIds).catch((error) => ({ error: String(error instanceof Error ? error.message : error).slice(0, 200) })),
      syncCommerceListings("base", resyncVariantIds.length, false, resyncVariantIds).catch((error) => ({ error: String(error instanceof Error ? error.message : error).slice(0, 200) })),
    ]);
    const summarize = (result: unknown) => {
      const r = result as { processed?: number; published?: number; failed?: number; error?: string; results?: Array<{ variantId?: string; ok?: boolean; error?: string }> };
      return { processed: r.processed ?? r.published ?? 0, failed: r.failed ?? 0, error: r.error ?? null, failures: (r.results ?? []).filter((x) => !x.ok).slice(0, 10) };
    };
    sync = { shopify: summarize(shopify), base: summarize(base) };
  }

  return NextResponse.json({
    ok: errors.length === 0 && unresolved.length === 0,
    readOnly: false,
    plan,
    withdrawn: withdrawProducts.length,
    legacy: legacyResult,
    hidden,
    newfind,
    newfindUrls,
    sync,
    errors,
  }, { status: errors.length ? 207 : 200 });
}

import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { classifyUnmappedBaseItem } from "@/lib/channels/base-unmapped-classify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type ListingRow = {
  id: string;
  title: string | null;
  product_id: string | null;
  published: boolean | null;
  base_item_id: string | number | null;
  selling_price: number | string | null;
  supplier_name: string | null;
  supplier_listing_id: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  inventory: number | null;
  orderable: boolean | null;
  base_publication_status: string | null;
};

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizedTitle(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function visibility(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

/** Read-only reconciliation report. Candidates are evidence only and never auto-mapped. */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => null) as {
      snapshot?: { complete?: unknown; items?: unknown };
    } | null;
    const snapshotItems = body?.snapshot?.items;
    if (
      body?.snapshot?.complete !== true ||
      !Array.isArray(snapshotItems) ||
      snapshotItems.length < 1 ||
      snapshotItems.some((item) => !item || typeof item !== "object" || Array.isArray(item))
    ) {
      return NextResponse.json(
        { ok: false, error: "BASE_SNAPSHOT_INPUT_INCOMPLETE_OR_INVALID", complete: false },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const typedSnapshotItems = snapshotItems as Record<string, unknown>[];
    const ids = typedSnapshotItems.map((item) => String(item.item_id ?? ""));
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      return NextResponse.json(
        { ok: false, error: "BASE_SNAPSHOT_INPUT_ID_MISSING_OR_DUPLICATE", complete: false },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const db = createSupabaseAdminClient();
    const listings: ListingRow[] = [];
    const pageSize = 1000;
    let complete = false;

    for (let page = 0; page < 10; page += 1) {
      const from = page * pageSize;
      const { data, error } = await db
        .from("shop_listings")
        .select("id,title,product_id,published,base_item_id,selling_price,supplier_name,supplier_listing_id,supplier_product_id,supplier_variant_id,inventory,orderable,base_publication_status")
        .order("created_at", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error("TRACER_LISTINGS_READ_FAILED");
      const rows = (data ?? []) as ListingRow[];
      listings.push(...rows);
      if (rows.length < pageSize) {
        complete = true;
        break;
      }
    }

    if (!complete) throw new Error("TRACER_LISTINGS_SCAN_INCOMPLETE");

    // Compare BASE's existing identifier field against exact TRACER/CJ identifiers
    // and SKU evidence. This is read-only; candidates are never auto-mapped here.
    const supplierListingIds = [...new Set(listings.map((row) => String(row.supplier_listing_id ?? "")).filter(Boolean))];
    const supplierEvidence = new Map<string, { sku: string | null; cjVariantId: string | null }>();
    for (let offset = 0; offset < supplierListingIds.length; offset += 100) {
      const batch = supplierListingIds.slice(offset, offset + 100);
      const { data, error } = await db
        .from("supplier_listings")
        .select("id,sku,cj_variant_id")
        .in("id", batch);
      if (error) throw new Error("TRACER_SUPPLIER_IDENTIFIER_READ_FAILED");
      for (const row of data ?? []) {
        supplierEvidence.set(String(row.id), {
          sku: text(row.sku),
          cjVariantId: text(row.cj_variant_id),
        });
      }
    }

    // Read the current commerce-native BASE channel catalog as well as legacy
    // shop_listings. The current publisher writes the BASE SKU into BASE's
    // identifier field and stores the exact BASE item ID in channel_listings.
    // Page every read: PostgREST caps one response at 1000 rows, and long id
    // lists are split so the request URL stays bounded.
    const commerceRows: Array<Record<string, unknown>> = [];
    for (let from = 0; ; from += 1000) {
      if (from >= 50_000) throw new Error("TRACER_COMMERCE_CHANNEL_SCAN_INCOMPLETE");
      const { data, error } = await db
        .from("channel_listings")
        .select("id,variant_id,external_product_id,external_sku,status,selling_price")
        .eq("channel", "base")
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error("TRACER_COMMERCE_CHANNEL_READ_FAILED");
      commerceRows.push(...((data ?? []) as Array<Record<string, unknown>>));
      if ((data ?? []).length < 1000) break;
    }
    type Chunk = (ids: string[]) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
    const readIn = async (values: string[], query: Chunk, stage: string) => {
      const out: Array<Record<string, unknown>> = [];
      for (let offset = 0; offset < values.length; offset += 100) {
        const { data, error } = await query(values.slice(offset, offset + 100));
        if (error) throw new Error(stage);
        out.push(...((data ?? []) as Array<Record<string, unknown>>));
      }
      return out;
    };
    const commerceVariantIds = [...new Set(commerceRows.map((row) => String(row.variant_id ?? "")).filter(Boolean))];
    const commerceVariants = await readIn(commerceVariantIds, (ids) => db.from("commerce_variants").select("id,product_id,source_variant_key,sku,title_ja").in("id", ids), "TRACER_COMMERCE_VARIANT_READ_FAILED");
    const commerceProductIds = [...new Set(commerceVariants.map((row) => String(row.product_id ?? "")).filter(Boolean))];
    const commerceProducts = await readIn(commerceProductIds, (ids) => db.from("commerce_products").select("id,source_key,title_ja,active").in("id", ids), "TRACER_COMMERCE_PRODUCT_READ_FAILED");
    const commercePrices = await readIn(commerceVariantIds, (ids) => db.from("commerce_prices").select("variant_id,supplier_offer_id,selling_price,expected_profit").in("variant_id", ids), "TRACER_COMMERCE_PRICE_READ_FAILED");
    const commerceOfferIds = [...new Set(commercePrices.map((row) => String(row.supplier_offer_id ?? "")).filter(Boolean))];
    const commerceOffers = await readIn(commerceOfferIds, (ids) => db.from("supplier_offers").select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,inventory,source_status,tracking_supported,ship_to,last_checked_at").in("id", ids), "TRACER_COMMERCE_OFFER_READ_FAILED");

    const variantById = new Map(commerceVariants.map((row) => [String(row.id), row]));
    const productById = new Map(commerceProducts.map((row) => [String(row.id), row]));
    const priceByVariant = new Map(commercePrices.map((row) => [String(row.variant_id), row]));
    const offerById = new Map(commerceOffers.map((row) => [String(row.id), row]));
    const commerceListingRows: ListingRow[] = commerceRows.map((channelRow) => {
      const variant = variantById.get(String(channelRow.variant_id));
      const product = variant ? productById.get(String(variant.product_id)) : null;
      const price = priceByVariant.get(String(channelRow.variant_id));
      const offer = price?.supplier_offer_id ? offerById.get(String(price.supplier_offer_id)) : null;
      const checkedAt = typeof offer?.last_checked_at === "string" ? Date.parse(offer.last_checked_at) : Number.NaN;
      const fresh = Number.isFinite(checkedAt) && checkedAt <= Date.now() + 5 * 60_000 && Date.now() - checkedAt <= 24 * 60 * 60_000;
      const exactVariant = Boolean(variant && offer && String(variant.source_variant_key) === String(offer.supplier_variant_id));
      const orderable = Boolean(exactVariant && offer?.source_status === "verified" && offer?.tracking_supported === true &&
        offer?.ship_to === "JP" && Number(offer?.inventory) > 0 && fresh &&
        Number(price?.selling_price) > 0 && Number(price?.expected_profit) > 0);
      return {
        id: String(channelRow.id),
        title: text(variant?.title_ja) ?? text(product?.title_ja),
        product_id: product ? String(product.id) : null,
        published: channelRow.status === "published",
        base_item_id: channelRow.external_product_id == null ? null : String(channelRow.external_product_id),
        selling_price: channelRow.selling_price as number | null,
        supplier_name: offer ? String(offer.supplier_code) : null,
        supplier_listing_id: offer ? String(offer.id) : null,
        supplier_product_id: offer ? String(offer.supplier_product_id) : null,
        supplier_variant_id: offer ? String(offer.supplier_variant_id) : null,
        inventory: offer ? Number(offer.inventory) : null,
        orderable,
        base_publication_status: channelRow.status == null ? null : String(channelRow.status),
      };
    });
    const reconciliationListings = [...listings, ...commerceListingRows];

    const identifierKey = (value: unknown): string => String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
    const bySupplierIdentifier = new Map<string, ListingRow[]>();
    const addSupplierIdentifier = (value: unknown, listing: ListingRow) => {
      const key = identifierKey(value);
      if (!key) return;
      const group = bySupplierIdentifier.get(key) ?? [];
      if (!group.some((row) => row.id === listing.id)) group.push(listing);
      bySupplierIdentifier.set(key, group);
    };

    const byBaseId = new Map<string, ListingRow[]>();
    const byTitle = new Map<string, ListingRow[]>();
    const byListingId = new Map<string, ListingRow>();
    for (const listing of reconciliationListings) {
      if (listings.some((legacy) => String(legacy.id) === String(listing.id))) {
        byListingId.set(String(listing.id).toLowerCase(), listing);
      }
      addSupplierIdentifier(listing.supplier_listing_id, listing);
      addSupplierIdentifier(listing.supplier_product_id, listing);
      addSupplierIdentifier(listing.supplier_variant_id, listing);
      const evidence = supplierEvidence.get(String(listing.supplier_listing_id ?? ""));
      addSupplierIdentifier(evidence?.cjVariantId, listing);
      addSupplierIdentifier(evidence?.sku, listing);
      const baseId = String(listing.base_item_id ?? "").trim();
      if (baseId) {
        const group = byBaseId.get(baseId) ?? [];
        group.push(listing);
        byBaseId.set(baseId, group);
      }
      const title = normalizedTitle(listing.title);
      if (title) {
        const group = byTitle.get(title) ?? [];
        group.push(listing);
        byTitle.set(title, group);
      }
    }

    // The current commerce publisher sets BASE's identifier to a stable
    // TRC-<24 hex> storefront SKU, while the actual supplier SKU remains on
    // commerce_variants. Index both identifiers against the same exact row.
    const commerceListingById = new Map(commerceListingRows.map((row) => [String(row.id), row]));
    for (const channelRow of commerceRows) {
      const listing = commerceListingById.get(String(channelRow.id));
      if (!listing) continue;
      addSupplierIdentifier(channelRow.external_sku, listing);
      const variant = variantById.get(String(channelRow.variant_id));
      addSupplierIdentifier(variant?.sku, listing);
    }

    const items = typedSnapshotItems.map((item) => {
      const baseItemId = String(item.item_id ?? "");
      const title = String(item.title ?? item.name ?? "");
      const key = normalizedTitle(title);
      const identifier = text(item.identifier);
      const stableIdentifierMatch = identifier?.match(/^TRC-(?:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})|([0-9a-f]{24}))$/i);
      const stableIdentifierListingId = stableIdentifierMatch?.[1]?.toLowerCase() ?? null;
      const supplierIdentifierCandidates = identifier
        ? (bySupplierIdentifier.get(identifierKey(identifier)) ?? [])
        : [];
      const stableIdentifierListing = stableIdentifierListingId
        ? byListingId.get(stableIdentifierListingId) ?? null
        : stableIdentifierMatch?.[2] && supplierIdentifierCandidates.length === 1
          ? supplierIdentifierCandidates[0]
          : null;
      const exactIdListings = byBaseId.get(baseItemId) ?? [];
      const titleCandidates = key ? (byTitle.get(key) ?? []) : [];
      const unmapped = exactIdListings.length === 0
        ? classifyUnmappedBaseItem({
          identifier,
          stableMatch: stableIdentifierListing ? { listingId: stableIdentifierListing.id, existingBaseItemId: stableIdentifierListing.base_item_id } : null,
          supplierIdentifierMatches: supplierIdentifierCandidates.map((row) => ({ listingId: row.id, existingBaseItemId: row.base_item_id })),
          titleMatches: titleCandidates.map((row) => ({ listingId: row.id, existingBaseItemId: row.base_item_id })),
        })
        : null;
      return {
        baseItemId,
        unmappedCategory: unmapped?.category ?? null,
        safeLinkListingId: unmapped?.safeLinkListingId ?? null,
        identifier,
        stableIdentifierListingId,
        stableIdentifierMatchCount: stableIdentifierListing ? 1 : 0,
        stableIdentifierMatches: stableIdentifierListing ? [{
          listingId: stableIdentifierListing.id,
          title: stableIdentifierListing.title,
          published: stableIdentifierListing.published,
          existingBaseItemId: stableIdentifierListing.base_item_id,
          supplierListingId: stableIdentifierListing.supplier_listing_id,
          supplierProductId: stableIdentifierListing.supplier_product_id,
          supplierVariantId: stableIdentifierListing.supplier_variant_id,
          inventory: stableIdentifierListing.inventory,
          orderable: stableIdentifierListing.orderable,
          sellingPrice: stableIdentifierListing.selling_price,
          basePublicationStatus: stableIdentifierListing.base_publication_status,
        }] : [],
        exactSupplierIdentifierMatchCount: supplierIdentifierCandidates.length,
        exactSupplierIdentifierMatches: supplierIdentifierCandidates.slice(0, 20).map((row) => ({
          listingId: row.id,
          title: row.title,
          productId: row.product_id,
          published: row.published,
          existingBaseItemId: row.base_item_id,
          supplierListingId: row.supplier_listing_id,
          supplierProductId: row.supplier_product_id,
          supplierVariantId: row.supplier_variant_id,
          inventory: row.inventory,
          orderable: row.orderable,
          sellingPrice: row.selling_price,
          basePublicationStatus: row.base_publication_status,
        })),
        visible: visibility(item.visible),
        title,
        price: item.price ?? null,
        stock: item.stock ?? null,
        exactBaseIdMatchCount: exactIdListings.length,
        exactBaseIdMatches: exactIdListings.map((row) => ({
          listingId: row.id,
          title: row.title,
          published: row.published,
          supplierName: row.supplier_name,
          supplierListingId: row.supplier_listing_id,
          supplierProductId: row.supplier_product_id,
          supplierVariantId: row.supplier_variant_id,
          inventory: row.inventory,
          orderable: row.orderable,
          sellingPrice: row.selling_price,
          basePublicationStatus: row.base_publication_status,
        })),
        exactTitleCandidateCount: titleCandidates.length,
        exactTitleCandidates: titleCandidates.slice(0, 20).map((row) => ({
          listingId: row.id,
          title: row.title,
          productId: row.product_id,
          published: row.published,
          existingBaseItemId: row.base_item_id,
          supplierName: row.supplier_name,
          supplierListingId: row.supplier_listing_id,
          supplierProductId: row.supplier_product_id,
          supplierVariantId: row.supplier_variant_id,
          inventory: row.inventory,
          orderable: row.orderable,
          sellingPrice: row.selling_price,
          basePublicationStatus: row.base_publication_status,
          priceDifference: Number.isFinite(Number(item.price)) && Number.isFinite(Number(row.selling_price))
            ? Number(row.selling_price) - Number(item.price)
            : null,
        })),
      };
    });

    const exactMapped = items.filter((item) => item.exactBaseIdMatchCount === 1).length;
    const unmapped = items.filter((item) => item.exactBaseIdMatchCount === 0).length;
    const ambiguous = items.filter((item) => item.exactBaseIdMatchCount > 1).length;
    const titleCandidateCount = items.filter((item) =>
      item.exactBaseIdMatchCount === 0
      && item.stableIdentifierMatchCount === 0
      && item.exactTitleCandidateCount === 1,
    ).length;
    const ambiguousTitleCandidateCount = items.filter((item) =>
      item.exactBaseIdMatchCount === 0
      && item.stableIdentifierMatchCount === 0
      && item.exactTitleCandidateCount > 1,
    ).length;
    const unmappedClassification: Record<string, { total: number; visible: number; hidden: number; samples: Array<{ baseItemId: string; identifier: string | null; title: string; visible: boolean | null }> }> = {};
    for (const item of items) {
      if (!item.unmappedCategory) continue;
      const bucket = unmappedClassification[item.unmappedCategory] ??= { total: 0, visible: 0, hidden: 0, samples: [] };
      bucket.total += 1;
      if (item.visible === true) bucket.visible += 1;
      if (item.visible === false) bucket.hidden += 1;
      if (bucket.samples.length < 10) bucket.samples.push({ baseItemId: item.baseItemId, identifier: item.identifier, title: item.title.slice(0, 80), visible: item.visible });
    }
    const report = {
      schemaVersion: 3,
      unmappedClassification,
      safeLinkCandidateCount: items.filter((item) => item.safeLinkListingId).length,
      generatedAt: new Date().toISOString(),
      source: "BASE /items + TRACER shop_listings read-only reconciliation",
      complete: complete,
      baseItemCount: typedSnapshotItems.length,
      baseVisibleCount: typedSnapshotItems.filter((item) => visibility(item.visible) === true).length,
      baseHiddenCount: typedSnapshotItems.filter((item) => visibility(item.visible) === false).length,
      tracerListingCount: reconciliationListings.length,
      commerceChannelListingCount: commerceRows.length,
      exactBaseIdMappedCount: exactMapped,
      baseItemsWithoutExactMappingCount: unmapped,
      baseItemsWithAmbiguousExactMappingCount: ambiguous,
      baseItemsWithExactTitleCandidateCount: titleCandidateCount,
      baseItemsWithAmbiguousExactTitleCandidateCount: ambiguousTitleCandidateCount,
      baseItemsWithExactSupplierIdentifierCandidateCount: items.filter((item) => item.exactSupplierIdentifierMatchCount === 1).length,
      baseItemsWithAmbiguousSupplierIdentifierCandidateCount: items.filter((item) => item.exactSupplierIdentifierMatchCount > 1).length,
      commerceTrcIdentifierMatchCount: items.filter((item) => /^TRC-[0-9a-f]{24}$/i.test(String(item.identifier ?? "")) && item.stableIdentifierMatchCount === 1).length,
      tracerListingsWithoutBaseItemIdCount: reconciliationListings.filter((row) => !String(row.base_item_id ?? "").trim()).length,
      duplicateBaseItemIdGroupsInTracer: [...byBaseId.entries()].filter(([, rows]) => rows.length > 1).length,
      note: "Exact-title candidates are unverified suggestions only. This report never writes mappings or changes BASE listings.",
      items,
    };
    const stableIdentifierAudit = items
      .filter((item) => /^TRC-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(item.identifier ?? "")))
      .map((item) => ({
        baseItemId: item.baseItemId,
        identifier: item.identifier,
        title: item.title,
        visible: item.visible,
        stableIdentifierListingId: item.stableIdentifierListingId,
        stableIdentifierMatchCount: item.stableIdentifierMatchCount,
        stableIdentifierMatches: item.stableIdentifierMatches,
        exactBaseIdMatchCount: item.exactBaseIdMatchCount,
        exactTitleCandidateCount: item.exactTitleCandidateCount,
        exactTitleCandidateListingIds: item.exactTitleCandidates.map((candidate) => candidate.listingId),
      }))
      .sort((a, b) => String(a.identifier).localeCompare(String(b.identifier)));
    console.info("[TRACER BASE STABLE-ID RECONCILIATION]", JSON.stringify({
      generatedAt: report.generatedAt,
      complete: report.complete,
      baseItemCount: report.baseItemCount,
      exactBaseIdMappedCount: report.exactBaseIdMappedCount,
      baseItemsWithoutExactMappingCount: report.baseItemsWithoutExactMappingCount,
      baseItemsWithAmbiguousExactMappingCount: report.baseItemsWithAmbiguousExactMappingCount,
      baseItemsWithExactTitleCandidateCount: report.baseItemsWithExactTitleCandidateCount,
      stableIdentifierCount: stableIdentifierAudit.length,
      stableIdentifierListingMatchedCount: stableIdentifierAudit.filter((item) => item.stableIdentifierMatchCount === 1).length,
      stableIdentifierBaseItemIdAlreadyExactCount: stableIdentifierAudit.filter((item) => item.stableIdentifierMatches[0]?.existingBaseItemId != null && String(item.stableIdentifierMatches[0].existingBaseItemId) === String(item.baseItemId)).length,
      stableIdentifierBaseItemIdMissingCount: stableIdentifierAudit.filter((item) => item.stableIdentifierMatchCount === 1 && item.stableIdentifierMatches[0]?.existingBaseItemId == null).length,
      stableIdentifierBaseItemIdConflictCount: stableIdentifierAudit.filter((item) => item.stableIdentifierMatchCount === 1 && item.stableIdentifierMatches[0]?.existingBaseItemId != null && String(item.stableIdentifierMatches[0].existingBaseItemId) !== String(item.baseItemId)).length,
      stableIdentifierAudit,
    }));
    const date = report.generatedAt.slice(0, 10);
    return new Response(JSON.stringify(report, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"tracer-base-reconciliation-" + date + ".json\"",
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "BASE_RECONCILIATION_FAILED";
    const stage = message.split(":")[0].slice(0, 100);
    console.error("[TRACER BASE RECONCILIATION FAILED]", { stage });
    return NextResponse.json(
      { ok: false, error: stage, complete: false },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

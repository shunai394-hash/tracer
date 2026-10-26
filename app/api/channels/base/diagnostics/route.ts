import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getLinkedSupplierListingIds } from "@/lib/catalog/canonical-supplier-identity";
import { probeBaseReadOnly, isBaseConfigured, BASE_ITEMS_MAX_PAGES } from "@/lib/channels/base";
import { classifyBaseIdentifier, decideCommerceSkuLink } from "@/lib/channels/base-item-identity";
import { classifyBaseMappingCounts } from "@/lib/channels/base-mapping-audit";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Read-only probe. Never returns item IDs, order IDs, customer data, or credentials. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    if (!isBaseConfigured()) {
      console.info("[TRACER BASE AUTH PROBE]", {
        configured: false, ordersApiStatus: null, itemsApiStatus: null,
      });
      return NextResponse.json(
        { ok: false, configured: false, baseApi: false, ordersApiStatus: null, itemsApiStatus: null, error: "BASE_OAUTH_CONFIG_INCOMPLETE" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const probe = await probeBaseReadOnly({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
    const mappingAudit = {
      ok: false,
      visibleItemsMatchedToDatabase: 0,
      visibleItemsManagedByCommerce: 0,
      visibleItemsLinked: 0,
      visibleItemsUnlinked: 0,
      visibleItemsWithoutDbMapping: 0,
      visibleItemsWithAmbiguousDbMapping: 0,
      // Distinguish missing fulfilment evidence from stale evidence age. This is
      // read-only diagnostics only; it does not change publication or unpublish policy.
      commerceFulfillmentBlockReasons: {} as Record<string, number>,
      commerceEvidenceStaleCount: 0,
      itemIdentifierPresentCount: probe.items.entries.filter((entry) => Boolean(entry.identifier)).length,
      stableTracerIdentifierCount: probe.items.entries.filter((entry) => /^TRC-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.identifier ?? "")).length,
      itemIdMissingCount: probe.items.entries.filter((entry) => !entry.itemId).length,
      duplicateItemCount: probe.items.duplicateItemCount,
      unmappedVisibleItems: {
        missingIdentifier: 0,
        otherIdentifier: 0,
        legacyUuidRepairable: 0,
        legacyUuidAlreadyStored: 0,
        legacyUuidDifferentBaseId: 0,
        legacyUuidNoRow: 0,
        commerceSkuRepairable: 0,
        commerceSkuAlreadyStored: 0,
        commerceSkuDifferentExternalId: 0,
        commerceSkuAmbiguous: 0,
        commerceSkuNoRow: 0,
        baseItemAlreadyMapped: 0,
      },
      errorStage: null as string | null,
    };

    if (probe.items.apiStatus !== 200 || !probe.items.complete) {
      mappingAudit.errorStage = probe.items.apiStatus !== 200
        ? "base_items_read_failed"
        : "base_items_scan_incomplete";
    } else {
      const visibleEntries = probe.items.entries.filter((entry) => entry.visible === true && entry.itemId);
      const externalIds = [...new Set(visibleEntries.map((entry) => String(entry.itemId)))];
      if (externalIds.length === 0 && probe.items.visibleCount > 0) {
        mappingAudit.errorStage = "base_visible_item_ids_missing";
      } else if (externalIds.length > 0) {
        try {
          const db = createSupabaseAdminClient();
          const listingRows: Array<{ id: string; base_item_id: string | number | null; supplier_listing_id: string | null }> = [];
          for (let offset = 0; offset < externalIds.length; offset += 100) {
            const batch = externalIds.slice(offset, offset + 100);
            const { data, error: listingError } = await db
              .from("shop_listings")
              .select("id,base_item_id,supplier_listing_id")
              .in("base_item_id", batch);
            if (listingError) throw new Error("base_listing_mapping_db_read_failed");
            listingRows.push(...(data ?? []));
          }

          const rowsByBaseId = new Map<string, Array<{ id: string; base_item_id: string | number | null; supplier_listing_id: string | null }>>();
          for (const row of listingRows ?? []) {
            const key = String(row.base_item_id ?? "");
            const existing = rowsByBaseId.get(key) ?? [];
            existing.push({
              id: String(row.id),
              base_item_id: row.base_item_id,
              supplier_listing_id: row.supplier_listing_id == null ? null : String(row.supplier_listing_id),
            });
            rowsByBaseId.set(key, existing);
          }
          const linkedSupplierIds = await getLinkedSupplierListingIds(
            (listingRows ?? []).map((row) => row.supplier_listing_id),
          );

          // The active commerce pipeline uses channel_listings/commerce_variants/
          // supplier_offers, not the retired shop_listings table. Include both
          // representations so diagnostics don't falsely report zero managed
          // BASE items after the commerce migration.
          const commerceRows: Array<{ id: string; variant_id: string | null; external_product_id: string | null; status: string | null }> = [];
          for (let offset = 0; offset < externalIds.length; offset += 100) {
            const batch = externalIds.slice(offset, offset + 100);
            const { data, error: commerceError } = await db
              .from("channel_listings")
              .select("id,variant_id,external_product_id,status")
              .eq("channel", "base")
              .in("external_product_id", batch);
            if (commerceError) throw new Error("base_commerce_mapping_db_read_failed");
            commerceRows.push(...(data ?? []));
          }
          const variantIds = [...new Set(commerceRows.map((row) => String(row.variant_id ?? "")).filter(Boolean))];
          const variants: Array<{ id: string; product_id: string | null; source_variant_key: string | null; sku: string | null }> = [];
          const prices: Array<{ variant_id: string; supplier_offer_id: string | null; selling_price: number | null; expected_profit: number | null }> = [];
          for (let offset = 0; offset < variantIds.length; offset += 100) {
            const batch = variantIds.slice(offset, offset + 100);
            const [variantResult, priceResult] = await Promise.all([
              db.from("commerce_variants").select("id,product_id,source_variant_key,sku").in("id", batch),
              db.from("commerce_prices").select("variant_id,supplier_offer_id,selling_price,expected_profit").in("variant_id", batch),
            ]);
            if (variantResult.error) throw new Error("base_commerce_variant_read_failed");
            if (priceResult.error) throw new Error("base_commerce_price_read_failed");
            variants.push(...(variantResult.data ?? []));
            prices.push(...(priceResult.data ?? []));
          }
          const offerIds = [...new Set(prices.map((row) => String(row.supplier_offer_id ?? "")).filter(Boolean))];
          const offers: Array<{ id: string; variant_id: string | null; supplier_code: string | null; supplier_product_id: string | null; supplier_variant_id: string | null; inventory: number | null; source_status: string | null; tracking_supported: boolean | null; ship_to: string | null; last_checked_at: string | null }> = [];
          for (let offset = 0; offset < offerIds.length; offset += 100) {
            const { data, error: offersError } = await db.from("supplier_offers")
              .select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,inventory,source_status,tracking_supported,ship_to,last_checked_at")
              .in("id", offerIds.slice(offset, offset + 100));
            if (offersError) throw new Error("base_commerce_offer_read_failed");
            offers.push(...(data ?? []));
          }

          const variantById = new Map(variants.map((row) => [String(row.id), row]));
          const priceByVariant = new Map(prices.map((row) => [String(row.variant_id), row]));
          const offerById = new Map(offers.map((row) => [String(row.id), row]));
          const commerceByBaseId = new Map<string, Array<{ listingId: string; variantId: string; status: string | null }>>();
          for (const row of commerceRows ?? []) {
            const key = String(row.external_product_id ?? "");
            const group = commerceByBaseId.get(key) ?? [];
            group.push({ listingId: String(row.id), variantId: String(row.variant_id), status: row.status == null ? null : String(row.status) });
            commerceByBaseId.set(key, group);
          }

          const unmappedEntries: typeof visibleEntries = [];
          for (const entry of visibleEntries) {
            const key = String(entry.itemId);
            const legacyMatches = rowsByBaseId.get(key) ?? [];
            const commerceMatches = commerceByBaseId.get(key) ?? [];
            const mapping = classifyBaseMappingCounts(legacyMatches.length, commerceMatches.length);
            if (mapping.kind === "none") {
              mappingAudit.visibleItemsWithoutDbMapping += 1;
              unmappedEntries.push(entry);
              continue;
            }
            mappingAudit.visibleItemsMatchedToDatabase += 1;
            if (mapping.kind === "ambiguous") {
              mappingAudit.visibleItemsWithAmbiguousDbMapping += 1;
              continue;
            }

            // channel_listings is the active commerce source of truth. A single
            // exact commerce mapping takes precedence over retired shop_listings
            // rows left behind by migration; only duplicate candidates within
            // the authoritative table (or legacy-only candidates) are ambiguous.
            if (mapping.kind === "commerce") {
              mappingAudit.visibleItemsManagedByCommerce += 1;
              const listing = commerceMatches[0];
              const variant = variantById.get(listing.variantId);
              const price = priceByVariant.get(listing.variantId);
              const offer = price?.supplier_offer_id ? offerById.get(String(price.supplier_offer_id)) : null;
              const checkedAt = typeof offer?.last_checked_at === "string" ? Date.parse(offer.last_checked_at) : Number.NaN;
              const fresh = Number.isFinite(checkedAt) && checkedAt <= Date.now() + 5 * 60_000 && Date.now() - checkedAt <= 24 * 60 * 60_000;
              const exactVariant = Boolean(variant && offer && String(variant.source_variant_key) === String(offer.supplier_variant_id));
              const blockers: string[] = [];
              if (listing.status !== "published") blockers.push("channel_listing_not_published");
              if (!variant) blockers.push("commerce_variant_missing");
              if (!price) blockers.push("commerce_price_missing");
              if (!offer) blockers.push("supplier_offer_missing");
              if (offer && !exactVariant) blockers.push("supplier_variant_mismatch");
              if (offer && offer.source_status !== "verified") blockers.push("supplier_offer_not_verified");
              if (offer && offer.tracking_supported !== true) blockers.push("tracking_unsupported");
              if (offer && offer.ship_to !== "JP") blockers.push("ship_to_not_jp");
              if (offer && (!Number.isFinite(Number(offer.inventory)) || Number(offer.inventory) <= 0)) blockers.push("inventory_unknown_or_zero");
              if (price && (!Number.isFinite(Number(price.selling_price)) || Number(price.selling_price) <= 0)) blockers.push("selling_price_invalid");
              if (price && (!Number.isFinite(Number(price.expected_profit)) || Number(price.expected_profit) <= 0)) blockers.push("profit_non_positive_or_unknown");
              if (!fresh) {
                mappingAudit.commerceEvidenceStaleCount += 1;
                blockers.push("evidence_stale");
              }
              for (const reason of blockers) {
                mappingAudit.commerceFulfillmentBlockReasons[reason] = (mappingAudit.commerceFulfillmentBlockReasons[reason] ?? 0) + 1;
              }
              const fulfillable = blockers.length === 0;
              if (fulfillable) mappingAudit.visibleItemsLinked += 1;
              else mappingAudit.visibleItemsUnlinked += 1;
              continue;
            }

            const supplierId = legacyMatches[0].supplier_listing_id;
            if (!supplierId || !linkedSupplierIds.has(supplierId)) {
              mappingAudit.visibleItemsUnlinked += 1;
            } else {
              mappingAudit.visibleItemsLinked += 1;
            }
          }
          const reasons = mappingAudit.unmappedVisibleItems;
          const parsed = unmappedEntries.map((entry) => ({
            itemId: String(entry.itemId),
            identity: classifyBaseIdentifier(entry.identifier),
          }));
          const legacyIds = [...new Set(parsed.flatMap((row) => row.identity.kind === "legacy_uuid" ? [row.identity.listingId] : []))];
          const skus = [...new Set(parsed.flatMap((row) => row.identity.kind === "commerce_sku" ? [row.identity.sku] : []))];
          const legacyRows: Array<{ id: string; base_item_id: string | null }> = [];
          const skuRows: Array<{ id: string; external_sku: string | null; external_product_id: string | null }> = [];
          for (let offset = 0; offset < legacyIds.length; offset += 100) {
            const { data, error } = await db.from("shop_listings").select("id,base_item_id").in("id", legacyIds.slice(offset, offset + 100));
            if (error) throw new Error("base_unmapped_legacy_lookup_failed");
            legacyRows.push(...(data ?? []));
          }
          for (let offset = 0; offset < skus.length; offset += 100) {
            const { data, error } = await db.from("channel_listings").select("id,external_sku,external_product_id").eq("channel", "base").in("external_sku", skus.slice(offset, offset + 100));
            if (error) throw new Error("base_unmapped_sku_lookup_failed");
            skuRows.push(...(data ?? []));
          }
          const legacyById = new Map(legacyRows.map((row) => [String(row.id).toLowerCase(), row]));
          const listingsBySku = new Map<string, Array<{ id: string; externalProductId: string | null }>>();
          for (const row of skuRows) {
            const sku = String(row.external_sku ?? "").toUpperCase();
            const group = listingsBySku.get(sku) ?? [];
            group.push({ id: String(row.id), externalProductId: row.external_product_id == null ? null : String(row.external_product_id) });
            listingsBySku.set(sku, group);
          }
          const baseIdsBySku = new Map<string, string[]>();
          for (const row of parsed) {
            if (row.identity.kind !== "commerce_sku") continue;
            const group = baseIdsBySku.get(row.identity.sku) ?? [];
            group.push(row.itemId);
            baseIdsBySku.set(row.identity.sku, group);
          }
          for (const row of parsed) {
            if (row.identity.kind === "missing") reasons.missingIdentifier += 1;
            else if (row.identity.kind === "other") reasons.otherIdentifier += 1;
            else if (row.identity.kind === "legacy_uuid") {
              const legacy = legacyById.get(row.identity.listingId);
              if (!legacy) reasons.legacyUuidNoRow += 1;
              else if (legacy.base_item_id == null) reasons.legacyUuidRepairable += 1;
              else if (String(legacy.base_item_id) === row.itemId) reasons.legacyUuidAlreadyStored += 1;
              else reasons.legacyUuidDifferentBaseId += 1;
            } else {
              const sku = row.identity.sku;
              const decision = decideCommerceSkuLink({
                baseItemId: row.itemId,
                listingsForSku: listingsBySku.get(sku) ?? [],
                otherBaseItemIdsWithSameSku: (baseIdsBySku.get(sku) ?? []).filter((id) => id !== row.itemId),
                listingIdsAlreadyUsingBaseItem: [],
              });
              if (decision.outcome === "repairable") reasons.commerceSkuRepairable += 1;
              else if (decision.outcome === "already_linked") reasons.commerceSkuAlreadyStored += 1;
              else if (decision.outcome === "listing_has_different_base_item") reasons.commerceSkuDifferentExternalId += 1;
              else if (decision.outcome === "no_listing") reasons.commerceSkuNoRow += 1;
              else if (decision.outcome === "base_item_already_mapped") reasons.baseItemAlreadyMapped += 1;
              else reasons.commerceSkuAmbiguous += 1;
            }
          }
          mappingAudit.ok = mappingAudit.itemIdMissingCount === 0
            && mappingAudit.visibleItemsWithoutDbMapping === 0
            && mappingAudit.visibleItemsWithAmbiguousDbMapping === 0
            && mappingAudit.visibleItemsUnlinked === 0;
        } catch {
          mappingAudit.errorStage = "base_listing_mapping_audit_failed";
        }
      } else {
        mappingAudit.ok = mappingAudit.itemIdMissingCount === 0;
      }
    }

    const result = {
      ok: probe.orders.apiStatus === 200
        && probe.items.apiStatus === 200
        && probe.items.errorStage === null
        && probe.items.complete
        && mappingAudit.ok,
      configured: true,
      baseApi: probe.orders.apiStatus === 200,
      ordersApiStatus: probe.orders.apiStatus,
      orderCountReturned: probe.orders.countReturned,
      dispatchStatuses: probe.orders.dispatchStatuses,
      itemsApi: probe.items.apiStatus === 200,
      itemsApiStatus: probe.items.apiStatus,
      itemCountReturned: probe.items.countReturned,
      visibleItemsReturned: probe.items.visibleCount,
      hiddenItemsReturned: probe.items.hiddenCount,
      unknownVisibilityCount: probe.items.unknownVisibilityCount,
      itemPages: probe.items.pages,
      itemAuditComplete: probe.items.complete,
      itemErrorStage: probe.items.errorStage,
      mappingAuditOk: mappingAudit.ok,
      visibleItemsMatchedToDatabase: mappingAudit.visibleItemsMatchedToDatabase,
      visibleItemsManagedByCommerce: mappingAudit.visibleItemsManagedByCommerce,
      visibleItemsLinked: mappingAudit.visibleItemsLinked,
      visibleItemsUnlinked: mappingAudit.visibleItemsUnlinked,
      visibleItemsWithoutDbMapping: mappingAudit.visibleItemsWithoutDbMapping,
      visibleItemsWithAmbiguousDbMapping: mappingAudit.visibleItemsWithAmbiguousDbMapping,
      commerceFulfillmentBlockReasons: mappingAudit.commerceFulfillmentBlockReasons,
      commerceEvidenceStaleCount: mappingAudit.commerceEvidenceStaleCount,
      itemIdentifierPresentCount: mappingAudit.itemIdentifierPresentCount,
      stableTracerIdentifierCount: mappingAudit.stableTracerIdentifierCount,
      itemIdMissingCount: mappingAudit.itemIdMissingCount,
      duplicateItemCount: mappingAudit.duplicateItemCount,
      unmappedVisibleItems: mappingAudit.unmappedVisibleItems,
      mappingAuditErrorStage: mappingAudit.errorStage,
    };
    console.info("[TRACER BASE AUTH PROBE]", result);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "BASE_DIAGNOSTIC_FAILED";
    const status = Number(message.match(/HTTP_(\d{3})/)?.[1] ?? 0) || null;
    const stage = message.split(":")[0].slice(0, 100);
    console.error("[TRACER BASE AUTH PROBE FAILED]", { stage, status });
    return NextResponse.json(
      { ok: false, configured: true, baseApi: false, ordersApiStatus: status, error: stage },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

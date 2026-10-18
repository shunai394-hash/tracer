import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchBaseItemsSnapshot, isBaseConfigured } from "@/lib/channels/base";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 120;

type BaseItem = Record<string, unknown>;
type ListingRow = {
  id: string;
  variant_id: string;
  external_product_id: string | null;
  external_variant_id: string | null;
  external_sku: string | null;
  selling_price: number;
  status: string;
};

function textValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function priceValue(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function visibleValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

/** Authenticated, read-only BASE API reconciliation. No listing is edited or published. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const headers = { "Cache-Control": "no-store" };
  if (!isBaseConfigured()) {
    return NextResponse.json(
      { ok: false, phase: "base_item_reconciliation", error: "BASE_OAUTH_CONFIG_INCOMPLETE" },
      { status: 503, headers },
    );
  }

  const runId = `base-api-${new Date().toISOString()}-${crypto.randomUUID()}`;
  try {
    const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: 50 });
    if (!snapshot.complete) {
      return NextResponse.json({
        ok: false,
        phase: "base_item_reconciliation",
        runId,
        apiReadComplete: false,
        itemCount: snapshot.items.length,
        pages: snapshot.pages,
        error: "BASE_ITEMS_SCAN_INCOMPLETE",
        auditRowsWritten: 0,
      }, { status: 502, headers });
    }

    const db = createSupabaseAdminClient();
    const { data: listingData, error: listingError } = await db
      .from("channel_listings")
      .select("id,variant_id,external_product_id,external_variant_id,external_sku,selling_price,status")
      .eq("channel", "base");
    if (listingError) throw new Error("BASE_RECONCILIATION_DB_LISTINGS_READ_FAILED");

    const listings = (listingData ?? []) as ListingRow[];
    const byExternalId = new Map<string, ListingRow[]>();
    const bySku = new Map<string, ListingRow[]>();
    for (const row of listings) {
      if (row.external_product_id) {
        const key = String(row.external_product_id);
        const group = byExternalId.get(key) ?? [];
        group.push(row);
        byExternalId.set(key, group);
      }
      const sku = textValue(row.external_sku)?.toUpperCase();
      if (sku) {
        const group = bySku.get(sku) ?? [];
        group.push(row);
        bySku.set(sku, group);
      }
    }

    const observedAt = new Date().toISOString();
    const auditRows = snapshot.items.map((item: BaseItem) => {
      const externalId = textValue(item.item_id);
      const identifier = textValue(item.identifier);
      const idCandidates = externalId ? byExternalId.get(externalId) ?? [] : [];
      const skuCandidates = identifier ? bySku.get(identifier.toUpperCase()) ?? [] : [];
      const candidates = idCandidates.length > 0 ? idCandidates : skuCandidates;
      const mappingMethod = idCandidates.length > 0 ? "base_item_id" : skuCandidates.length > 0 ? "exact_sku" : "none";
      const listing = candidates.length === 1 ? candidates[0] : null;
      const mappingStatus = candidates.length === 0 ? "unmapped" : candidates.length > 1 ? "ambiguous" : "matched";
      const externalPrice = priceValue(item.price);
      const visible = visibleValue(item.visible);
      const title = textValue(item.title);
      const priceMatches = listing && externalPrice !== null
        ? Math.round(externalPrice) === Number(listing.selling_price)
        : null;
      const skuMatches = listing && identifier
        ? identifier.toUpperCase() === String(listing.external_sku ?? "").toUpperCase()
        : null;

      return {
        run_id: runId,
        channel: "base",
        external_product_id: externalId,
        external_variant_id: listing?.external_variant_id ?? null,
        variant_id: listing?.variant_id ?? null,
        external_sku: identifier,
        internal_sku: listing?.external_sku ?? null,
        product_title: title,
        external_price: externalPrice,
        canonical_price: listing?.selling_price ?? null,
        db_channel_price: listing?.selling_price ?? null,
        product_status: visible === null ? "visibility_unknown" : visible ? "published" : "hidden",
        price_matches: priceMatches,
        sku_matches: skuMatches,
        observed_at: observedAt,
        details: {
          source: "base_items_api",
          apiReadComplete: true,
          apiVisible: visible,
          apiPricePresent: externalPrice !== null,
          mappingCount: candidates.length,
          mappingStatus,
          mappingMethod,
          candidateListingIds: candidates.map((candidate) => candidate.id),
          dbListingStatus: listing?.status ?? null,
          dbExternalSku: listing?.external_sku ?? null,
          identifier,
          discrepancyReasons: [
            ...(candidates.length === 0 ? ["no_db_mapping"] : []),
            ...(candidates.length > 1 ? ["ambiguous_db_mapping"] : []),
            ...(visible === null ? ["visibility_unreadable"] : []),
            ...(externalPrice === null ? ["external_price_unreadable"] : []),
            ...(listing && externalPrice !== null && Math.round(externalPrice) !== Number(listing.selling_price) ? ["price_mismatch"] : []),
            ...(listing && identifier && identifier.toUpperCase() !== String(listing.external_sku ?? "").toUpperCase() ? ["identifier_sku_mismatch"] : []),
          ],
        },
      };
    });

    let written = 0;
    for (let offset = 0; offset < auditRows.length; offset += 100) {
      const batch = auditRows.slice(offset, offset + 100);
      const { error } = await db.from("channel_price_reconciliation_audit").insert(batch);
      if (error) {
        console.error("[TRACER BASE RECONCILIATION AUDIT WRITE FAILED]", {
          runId,
          batchStart: offset,
          code: error.code ?? null,
          message: error.message?.slice(0, 240) ?? null,
        });
        const failedSummary = {
          apiReadComplete: true,
          apiErrors: 0,
          itemCount: snapshot.items.length,
          dbListingCount: listings.length,
          mappedItems: auditRows.filter((row) => row.details.mappingStatus === "matched").length,
          exactIdMatches: auditRows.filter((row) => row.details.mappingMethod === "base_item_id" && row.details.mappingStatus === "matched").length,
          exactSkuMatches: auditRows.filter((row) => row.details.mappingMethod === "exact_sku" && row.details.mappingStatus === "matched").length,
          unmappedItems: auditRows.filter((row) => row.details.mappingStatus === "unmapped").length,
          ambiguousItems: auditRows.filter((row) => row.details.mappingStatus === "ambiguous").length,
          missingSku: auditRows.filter((row) => !textValue(row.external_sku)).length,
          unknownVisibility: auditRows.filter((row) => row.product_status === "visibility_unknown").length,
          unreadablePrices: auditRows.filter((row) => row.external_price === null).length,
          priceMismatches: auditRows.filter((row) => row.price_matches === false).length,
          skuMismatches: auditRows.filter((row) => row.sku_matches === false).length,
        };
        return NextResponse.json({
          ok: false,
          phase: "base_item_reconciliation",
          runId,
          pages: snapshot.pages,
          auditRowsWritten: written,
          auditWriteFailed: true,
          auditWriteErrorCode: error.code ?? null,
          auditWriteError: error.message?.slice(0, 240) ?? "database insert failed",
          ...failedSummary,
          items: auditRows.map((row) => ({
            baseItemId: row.external_product_id,
            title: row.product_title,
            baseIdentifier: row.external_sku,
            basePrice: row.external_price,
            tracerVariantId: row.details.mappingStatus === "matched" ? row.variant_id : null,
            tracerSku: row.internal_sku,
            tracerPrice: row.canonical_price,
            baseVisibility: row.details.apiVisible,
            mappingStatus: row.details.mappingStatus,
            mappingMethod: row.details.mappingMethod,
            candidateCount: row.details.mappingCount,
            candidateListingIds: row.details.candidateListingIds,
            priceMatches: row.price_matches,
            skuMatches: row.sku_matches,
            discrepancyReasons: row.details.discrepancyReasons,
          })),
        }, { status: 207, headers });
      }
      written += batch.length;
    }

    const summary = {
      apiReadComplete: true,
      apiErrors: 0,
      itemCount: snapshot.items.length,
      dbListingCount: listings.length,
      mappedItems: auditRows.filter((row) => row.details.mappingStatus === "matched").length,
      exactIdMatches: auditRows.filter((row) => row.details.mappingMethod === "base_item_id" && row.details.mappingStatus === "matched").length,
      exactSkuMatches: auditRows.filter((row) => row.details.mappingMethod === "exact_sku" && row.details.mappingStatus === "matched").length,
      unmappedItems: auditRows.filter((row) => row.details.mappingStatus === "unmapped").length,
      ambiguousItems: auditRows.filter((row) => row.details.mappingStatus === "ambiguous").length,
      missingSku: auditRows.filter((row) => !textValue(row.external_sku)).length,
      unknownVisibility: auditRows.filter((row) => row.product_status === "visibility_unknown").length,
      unreadablePrices: auditRows.filter((row) => row.external_price === null).length,
      priceMismatches: auditRows.filter((row) => row.price_matches === false).length,
      skuMismatches: auditRows.filter((row) => row.sku_matches === false).length,
    };
    console.info("[TRACER BASE ITEM RECONCILIATION]", { runId, ...summary, auditRowsWritten: written });
    return NextResponse.json({
      ok: summary.apiReadComplete && summary.unmappedItems === 0 && summary.ambiguousItems === 0
        && summary.unknownVisibility === 0 && summary.unreadablePrices === 0
        && summary.priceMismatches === 0 && summary.skuMismatches === 0,
      phase: "base_item_reconciliation",
      runId,
      pages: snapshot.pages,
      auditRowsWritten: written,
      ...summary,
      items: auditRows.map((row) => ({
        baseItemId: row.external_product_id,
        title: row.product_title,
        baseIdentifier: row.external_sku,
        basePrice: row.external_price,
        tracerVariantId: row.details.mappingStatus === "matched" ? row.variant_id : null,
        tracerSku: row.internal_sku,
        tracerPrice: row.canonical_price,
        baseVisibility: row.details.apiVisible,
        mappingStatus: row.details.mappingStatus,
        mappingMethod: row.details.mappingMethod,
        candidateCount: row.details.mappingCount,
        candidateListingIds: row.details.candidateListingIds,
        priceMatches: row.price_matches,
        skuMatches: row.sku_matches,
        discrepancyReasons: row.details.discrepancyReasons,
      })),
    }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "BASE_RECONCILIATION_FAILED";
    const status = Number(message.match(/HTTP_(\d{3})/)?.[1] ?? 0) || null;
    console.error("[TRACER BASE ITEM RECONCILIATION FAILED]", {
      runId,
      stage: message.split(":")[0].slice(0, 100),
      status,
    });
    return NextResponse.json({
      ok: false,
      phase: "base_item_reconciliation",
      runId,
      apiReadComplete: false,
      error: message.split(":")[0].slice(0, 100),
      httpStatus: status,
      auditRowsWritten: 0,
    }, { status: 502, headers });
  }
}

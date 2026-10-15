import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getLinkedSupplierListingIds } from "@/lib/catalog/canonical-supplier-identity";
import { probeBaseReadOnly, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";

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

    const probe = await probeBaseReadOnly({ itemPageLimit: 100, itemMaxPages: 10 });
    const stableTracerIdentifier = /^TRC-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
    const mappingAudit = {
      ok: false,
      visibleItemsMatchedToDatabase: 0,
      visibleItemsMatchedByStableIdentifier: 0,
      visibleItemsMissingPersistedBaseMapping: 0,
      visibleItemsWithIdentifierConflict: 0,
      visibleItemsLinked: 0,
      visibleItemsUnlinked: 0,
      visibleItemsWithoutDbMapping: 0,
      visibleItemsWithAmbiguousDbMapping: 0,
      itemIdentifierPresentCount: probe.items.entries.filter((entry) => Boolean(entry.identifier)).length,
      stableTracerIdentifierCount: probe.items.entries.filter((entry) => stableTracerIdentifier.test(entry.identifier ?? "")).length,
      itemIdMissingCount: probe.items.entries.filter((entry) => !entry.itemId).length,
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
          const { data: listingRows, error: listingError } = await db
            .from("shop_listings")
            .select("id,base_item_id,supplier_listing_id")
            .in("base_item_id", externalIds);
          if (listingError) throw new Error("base_listing_mapping_db_read_failed");

          // BASE's identifier is set at creation to the exact stable value
          // TRC-<shop_listings.id>. Use it only as a read-only recovery signal;
          // never infer from title, price, or image and never write a mapping here.
          const stableListingIds = [...new Set(visibleEntries
            .map((entry) => stableTracerIdentifier.exec(entry.identifier ?? "")?.[1] ?? null)
            .filter((value): value is string => value !== null))];
          const { data: identifierRows, error: identifierError } = stableListingIds.length > 0
            ? await db.from("shop_listings").select("id,base_item_id,supplier_listing_id").in("id", stableListingIds)
            : { data: [], error: null };
          if (identifierError) throw new Error("base_stable_identifier_mapping_db_read_failed");

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
          const rowsByListingId = new Map((identifierRows ?? []).map((row) => [String(row.id), {
            id: String(row.id),
            base_item_id: row.base_item_id == null ? null : String(row.base_item_id),
            supplier_listing_id: row.supplier_listing_id == null ? null : String(row.supplier_listing_id),
          }] as const));
          const linkedSupplierIds = await getLinkedSupplierListingIds([
            ...(listingRows ?? []).map((row) => row.supplier_listing_id),
            ...(identifierRows ?? []).map((row) => row.supplier_listing_id),
          ]);

          for (const entry of visibleEntries) {
            const itemId = String(entry.itemId);
            const directMatches = rowsByBaseId.get(itemId) ?? [];
            if (directMatches.length > 1) {
              mappingAudit.visibleItemsMatchedToDatabase += 1;
              mappingAudit.visibleItemsWithAmbiguousDbMapping += 1;
              continue;
            }
            if (directMatches.length === 1) {
              mappingAudit.visibleItemsMatchedToDatabase += 1;
              const supplierId = directMatches[0].supplier_listing_id;
              if (!supplierId || !linkedSupplierIds.has(supplierId)) mappingAudit.visibleItemsUnlinked += 1;
              else mappingAudit.visibleItemsLinked += 1;
              continue;
            }

            const stableId = stableTracerIdentifier.exec(entry.identifier ?? "")?.[1];
            const stableMatch = stableId ? rowsByListingId.get(stableId) : null;
            if (!stableMatch) {
              mappingAudit.visibleItemsWithoutDbMapping += 1;
              continue;
            }

            mappingAudit.visibleItemsMatchedByStableIdentifier += 1;
            if (stableMatch.base_item_id && stableMatch.base_item_id !== itemId) {
              mappingAudit.visibleItemsWithIdentifierConflict += 1;
            } else if (!stableMatch.base_item_id) {
              mappingAudit.visibleItemsMissingPersistedBaseMapping += 1;
            }
            const supplierId = stableMatch.supplier_listing_id;
            if (!supplierId || !linkedSupplierIds.has(supplierId)) mappingAudit.visibleItemsUnlinked += 1;
            else mappingAudit.visibleItemsLinked += 1;
          }
          mappingAudit.ok = mappingAudit.itemIdMissingCount === 0
            && mappingAudit.visibleItemsWithoutDbMapping === 0
            && mappingAudit.visibleItemsWithAmbiguousDbMapping === 0
            && mappingAudit.visibleItemsWithIdentifierConflict === 0
            && mappingAudit.visibleItemsMissingPersistedBaseMapping === 0
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
      visibleItemsMatchedByStableIdentifier: mappingAudit.visibleItemsMatchedByStableIdentifier,
      visibleItemsMissingPersistedBaseMapping: mappingAudit.visibleItemsMissingPersistedBaseMapping,
      visibleItemsWithIdentifierConflict: mappingAudit.visibleItemsWithIdentifierConflict,
      visibleItemsLinked: mappingAudit.visibleItemsLinked,
      visibleItemsUnlinked: mappingAudit.visibleItemsUnlinked,
      visibleItemsWithoutDbMapping: mappingAudit.visibleItemsWithoutDbMapping,
      visibleItemsWithAmbiguousDbMapping: mappingAudit.visibleItemsWithAmbiguousDbMapping,
      itemIdentifierPresentCount: mappingAudit.itemIdentifierPresentCount,
      stableTracerIdentifierCount: mappingAudit.stableTracerIdentifierCount,
      itemIdMissingCount: mappingAudit.itemIdMissingCount,
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

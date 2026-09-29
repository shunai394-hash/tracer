import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { collectMarketplaceBestsellers } from "@/lib/market/collect-bestsellers";
import { writeEvidence } from "@/lib/market/evidence-ledger";
import { EMPTY_IDENTIFIERS, hasAnyIdentifier } from "@/lib/market/identifiers";

// Priority mirrors pickIdentifierQuery (lib/market/identifiers.ts): a real
// identifier of any scheme is always preferred over a title-text key, which
// only ever matches by coincidental exact string equality.
function buildIdentityKey(
  title: string,
  asin: string | null,
  jan: string | null,
  gtin: string | null,
  mpn: string | null,
): string {
  if (asin) return `asin::${asin}`;
  if (jan) return `jan::${jan}`;
  if (gtin) return `gtin::${gtin}`;
  if (mpn) return `mpn::${mpn}`;
  return `title::${title.toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]+/gi, " ").trim()}`;
}

export async function persistMarketplaceBestsellers(): Promise<{
  itemCount: number;
  inserted: number;
  productsCreated: number;
  skippedMarketplaces: string[];
  /** Per-marketplace detail-page enrichment telemetry (see collect-bestsellers.ts). */
  enrichment: Array<{ marketplace: string; attempted: number; htmlFetched: number; identifierFound: number }>;
  /** Exact bestseller row IDs inserted by this run; downstream stages must use these IDs. */
  bestsellerIds: string[];
  /** Exact current-run rows carrying at least one verified marketplace identifier. */
  supplierCandidateIds: string[];
}> {
  const collected = await collectMarketplaceBestsellers();
  const supabase = createSupabaseAdminClient();
  let inserted = 0;
  let productsCreated = 0;
  const bestsellerIds: string[] = [];
  const supplierCandidateIdsByMarketplace = new Map<string, string[]>();
  const seenMarketplaceIdentityKeys = new Map<string, Set<string>>();
  const skippedMarketplaces = collected.marketplaces
    .filter((item) => item.skipped)
    .map((item) => item.marketplace);

  for (const marketplace of collected.marketplaces) {
    for (const item of marketplace.items) {
      const identityKey = buildIdentityKey(item.title, item.asin, item.jan, item.gtin, item.mpn);
      const seen = seenMarketplaceIdentityKeys.get(marketplace.marketplace) ?? new Set<string>();
      if (seen.has(identityKey)) continue;
      seen.add(identityKey);
      seenMarketplaceIdentityKeys.set(marketplace.marketplace, seen);

      const sourceItemKey = [
        marketplace.source,
        item.asin || item.productUrl || [
          marketplace.marketplace,
          item.title,
          `rank:${item.rank ?? ""}`,
        ].join("::"),
      ].join("::");

      const { data: bestseller, error } = await supabase
        .from("marketplace_bestsellers")
        .upsert({ source_item_key: sourceItemKey,
          marketplace: marketplace.marketplace,
          rank: item.rank,
          category: null,
          title: item.title,
          brand: item.brand,
          model: item.model,
          asin: item.asin,
          jan: item.jan,
          gtin: item.gtin,
          ean: item.ean,
          upc: item.upc,
          mpn: item.mpn,
          price: item.price,
          currency: item.currency,
          review_count: item.reviewCount,
          product_url: item.productUrl,
          image_url: item.imageUrl,
          fetched_at: marketplace.fetchedAt,
          source: marketplace.source,
          source_url: marketplace.sourceUrl,
          raw: { parser: marketplace.source },
          pipeline_stage: "DISCOVERED",
          pipeline_status: "pending",
          pipeline_reason: "market_observation_persisted",
          pipeline_error: null,
          pipeline_updated_at: new Date().toISOString(),
        }, { onConflict: "source_item_key" })
        .select("id")
        .single();

      if (error) throw new Error(error.message);
      inserted += 1;
      bestsellerIds.push(String(bestseller.id));

      let productId: string | null = null;

      // Reuse an existing canonical product by any verified identifier.
      // Previously only ASIN/JAN could find an existing row, so a GTIN/MPN-only
      // bestseller could create a duplicate product even when the catalog
      // already contained the same item.
      const lookupIdentifiers: Array<[string, string | null]> = [
        ["asin", item.asin],
        ["jan", item.jan],
        ["gtin", item.gtin],
        ["ean", item.ean],
        ["upc", item.upc],
        ["mpn", item.mpn],
      ];
      for (const [scheme, value] of lookupIdentifiers) {
        if (!value || productId) continue;
        const existing = await supabase
          .from("products")
          .select("id")
          .eq(scheme, value)
          .maybeSingle();
        if (existing.error) throw new Error(existing.error.message);
        if (existing.data?.id) productId = existing.data.id;
      }

      if (productId) {
        // Existing canonical product found; do not create a duplicate.
      } else {
        const created = await supabase
          .from("products")
          .insert({
            canonical_name: item.title,
            identity_key: identityKey,
            asin: item.asin,
            jan: item.jan,
            gtin: item.gtin,
            ean: item.ean,
            upc: item.upc,
            mpn: item.mpn,
          })
          .select("id")
          .single();

        if (created.error) {
          const reused = await supabase
            .from("products")
            .select("id")
            .eq("identity_key", identityKey)
            .maybeSingle();
          if (reused.error) throw new Error(created.error.message);
          productId = reused.data?.id ?? null;
        } else {
          productId = created.data.id;
          productsCreated += 1;
        }
      }

      if (productId) {
        await supabase
          .from("marketplace_bestsellers")
          .update({ product_id: productId })
          .eq("id", bestseller.id);
      }

      const fields: Array<[string, string | number | null]> = [
        ["title", item.title],
        ["rank", item.rank],
        ["price", item.price],
        ["currency", item.currency],
        ["asin", item.asin],
        ["jan", item.jan],
        ["brand", item.brand],
        ["review_count", item.reviewCount],
        ["product_url", item.productUrl],
        ["image_url", item.imageUrl],
      ];

      for (const [field, value] of fields) {
        await writeEvidence({
          productId,
          bestsellerId: bestseller.id,
          source: marketplace.source,
          url: item.productUrl ?? marketplace.sourceUrl,
          fetchedAt: marketplace.fetchedAt,
          fieldName: field,
          fieldValue: value === null ? null : String(value),
          evidenceClass: value === null ? "unknown" : "actual",
          confidence: value === null ? 0 : 0.85,
        });
      }

      const ids = {
        ...EMPTY_IDENTIFIERS,
        asin: item.asin,
        jan: item.jan,
        gtin: item.gtin,
        ean: item.ean,
        upc: item.upc,
        mpn: item.mpn,
      };
      // ASIN is an Amazon identity anchor, not a supplier identifier.
      // ASIN-only rows still enter supplier investigation so title/brand
      // discovery can find an exact supplier product/variant.
      // Final sales eligibility remains fail-closed: ASIN alone never
      // links a supplier or makes a product sales-eligible.
      const hasSupplierSearchIdentifier = Boolean(
        ids.jan || ids.gtin || ids.ean || ids.upc || ids.mpn || ids.asin,
      );
      if (hasSupplierSearchIdentifier) {
        const key = marketplace.marketplace;
        const bucket = supplierCandidateIdsByMarketplace.get(key) ?? [];
        bucket.push(String(bestseller.id));
        supplierCandidateIdsByMarketplace.set(key, bucket);
      }

      if (productId && hasAnyIdentifier(ids)) {
        for (const [scheme, value] of Object.entries(ids)) {
          if (!value) continue;
          await supabase.from("product_identifiers").upsert(
            {
              product_id: productId,
              bestseller_id: bestseller.id,
              scheme,
              value,
              source: marketplace.source,
              fetched_at: marketplace.fetchedAt,
            },
            { onConflict: "scheme,value" },
          );
        }
      }
    }
  }

  // Do not let one marketplace consume the entire supplier-investigation
  // batch. Interleave sources so a single blocked/poorly-enriched catalog
  // cannot make the whole run look like "zero products".
  const supplierCandidateIds: string[] = [];
  const candidateBuckets = Array.from(supplierCandidateIdsByMarketplace.values());
  const maxBucketSize = Math.max(0, ...candidateBuckets.map((bucket) => bucket.length));
  for (let index = 0; index < maxBucketSize; index += 1) {
    for (const bucket of candidateBuckets) {
      const id = bucket[index];
      if (id) supplierCandidateIds.push(id);
    }
  }

  return {
    itemCount: collected.itemCount,
    inserted,
    productsCreated,
    skippedMarketplaces,
    enrichment: collected.marketplaces
      .filter((marketplace) => marketplace.enrichment)
      .map((marketplace) => ({ marketplace: marketplace.marketplace, ...marketplace.enrichment! })),
    bestsellerIds,
    supplierCandidateIds,
  };
}

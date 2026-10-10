import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { collectMarketplaceBestsellers } from "@/lib/market/collect-bestsellers";
import { writeEvidenceBatch } from "@/lib/market/evidence-ledger";
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

export async function persistMarketplaceBestsellers(options: { startIndex?: number; batchSize?: number; sourceIndex?: number } = {}): Promise<{
  itemCount: number;
  inserted: number;
  productsCreated: number;
  canonicalVariantEvidenceSchemaAvailable: boolean;
  canonicalVariantEvidenceParsed: number;
  canonicalVariantEvidenceWritten: number;
  canonicalVariantEvidenceWriteFailures: number;
  skippedMarketplaces: string[];
  /** Per-marketplace detail-page enrichment telemetry (see collect-bestsellers.ts). */
  enrichment: Array<{ marketplace: string; attempted: number; htmlFetched: number; identifierFound: number }>;
  /** Exact bestseller row IDs inserted by this run; downstream stages must use these IDs. */
  bestsellerIds: string[];
  /** Exact current-run rows carrying at least one verified marketplace identifier. */
  supplierCandidateIds: string[];
  startIndex: number;
  processedCount: number;
  sourceIndex: number;
  nextIndex: number;
  hasMore: boolean;
}> {
  const sourceIndex = Math.max(0, options.sourceIndex ?? 0);
  const collected = await collectMarketplaceBestsellers({ sourceIndex });
  const startIndex = Math.max(0, options.startIndex ?? 0);
  const batchSize = Math.max(1, options.batchSize ?? 50);
  const endIndex = startIndex + batchSize;
  let collectionIndex = 0;
  let processedCount = 0;
  const supabase = createSupabaseAdminClient();
  // Probe the canonical-variant evidence table even when this batch contains no
  // variants. Otherwise a missing migration could be reported as a clean run
  // simply because there were zero rows to write.
  const evidenceSchemaProbe = await supabase.from("marketplace_bestseller_variants").select("id").limit(1);
  const canonicalVariantEvidenceSchemaAvailable = !evidenceSchemaProbe.error;
  if (evidenceSchemaProbe.error) {
    console.error("[TRACER CANONICAL VARIANT EVIDENCE SCHEMA UNAVAILABLE]", {
      code: evidenceSchemaProbe.error.code,
      message: evidenceSchemaProbe.error.message,
    });
  }
  let inserted = 0;
  let productsCreated = 0;
  let canonicalVariantEvidenceParsed = 0;
  let canonicalVariantEvidenceWritten = 0;
  let canonicalVariantEvidenceWriteFailures = 0;
  const bestsellerIds: string[] = [];
  const supplierCandidateIdsByMarketplace = new Map<string, string[]>();
  const seenMarketplaceIdentityKeys = new Map<string, Set<string>>();
  const skippedMarketplaces = collected.marketplaces
    .filter((item) => item.skipped)
    .map((item) => item.marketplace);

  for (const marketplace of collected.marketplaces) {
    for (const item of marketplace.items) {
      const currentIndex = collectionIndex;
      collectionIndex += 1;
      if (currentIndex < startIndex) continue;
      if (currentIndex >= endIndex) break;
      processedCount += 1;
      const identityKey = buildIdentityKey(item.title, item.asin, item.jan, item.gtin, item.mpn);
      const seen = seenMarketplaceIdentityKeys.get(marketplace.marketplace) ?? new Set<string>();
      if (seen.has(identityKey)) continue;
      seen.add(identityKey);
      seenMarketplaceIdentityKeys.set(marketplace.marketplace, seen);

      const sourceItemKey = [
        marketplace.source,
        item.asin || item.productUrl || [
          marketplace.marketplace,
          item.title.toLowerCase().replace(/\s+/g, " ").trim(),
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
          // Do not write pipeline state during an observation upsert.
          // Re-observing an existing bestseller must never regress a row from
          // ready/blocked/published back to pending. New rows receive the
          // database defaults (DISCOVERED/pending).
        }, { onConflict: "source_item_key" })
        .select("id")
        .single();

      if (error) throw new Error(error.message);
      inserted += 1;
      bestsellerIds.push(String(bestseller.id));

      const variantEvidenceRows = (item.canonicalVariants ?? []).map((variant) => ({
        bestseller_id: bestseller.id,
        marketplace: marketplace.marketplace,
        source: marketplace.source,
        source_variant_id: variant.sourceVariantId,
        sku: variant.sku,
        title: variant.title,
        asin: variant.asin,
        jan: variant.jan,
        gtin: variant.gtin,
        ean: variant.ean,
        upc: variant.upc,
        mpn: variant.mpn,
        product_url: variant.productUrl,
        evidence_source: variant.evidenceSource,
        raw_evidence: variant.rawEvidence,
        fetched_at: marketplace.fetchedAt,
        updated_at: marketplace.fetchedAt,
      }));
      canonicalVariantEvidenceParsed += variantEvidenceRows.length;
      if (variantEvidenceRows.length > 0) {
        const { data: writtenVariants, error: variantWriteError } = await supabase
          .from("marketplace_bestseller_variants")
          .upsert(variantEvidenceRows, { onConflict: "bestseller_id,source_variant_id" })
          .select("id");
        if (variantWriteError) {
          // Keep ranking collection available during a staggered migration rollout,
          // but surface the missing/failed evidence write as a separate counter.
          canonicalVariantEvidenceWriteFailures += variantEvidenceRows.length;
          console.error("[TRACER CANONICAL VARIANT EVIDENCE WRITE FAILED]", {
            code: variantWriteError.code,
            message: variantWriteError.message,
            rows: variantEvidenceRows.length,
          });
        } else {
          // Count only rows explicitly returned by PostgREST. A successful HTTP
          // response with no representation is not proof that every row was stored.
          const writtenCount = writtenVariants?.length ?? 0;
          canonicalVariantEvidenceWritten += writtenCount;
          if (writtenCount < variantEvidenceRows.length) {
            canonicalVariantEvidenceWriteFailures += variantEvidenceRows.length - writtenCount;
            console.error("[TRACER CANONICAL VARIANT EVIDENCE WRITE COUNT MISMATCH]", {
              expected: variantEvidenceRows.length,
              returned: writtenCount,
            });
          }
        }
      }

      let productId: string | null = null;

      // Reuse an existing canonical product with a single indexed lookup.
      // The previous implementation performed up to six sequential queries
      // (ASIN/JAN/GTIN/EAN/UPC/MPN) for every bestseller. That made a small
      // cron batch surprisingly expensive under Vercel's hard timeout.
      const lookupFilters = [
        item.asin ? `asin.eq.${item.asin}` : null,
        item.jan ? `jan.eq.${item.jan}` : null,
        item.gtin ? `gtin.eq.${item.gtin}` : null,
        item.ean ? `ean.eq.${item.ean}` : null,
        item.upc ? `upc.eq.${item.upc}` : null,
        item.mpn ? `mpn.eq.${item.mpn}` : null,
      ].filter((value): value is string => Boolean(value));

      if (lookupFilters.length > 0) {
        const existing = await supabase
          .from("products")
          .select("id,asin,jan,gtin,ean,upc,mpn")
          .or(lookupFilters.join(","))
          .limit(1)
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

      const evidenceRows = fields.map(([field, value]) => ({
        productId,
        bestsellerId: bestseller.id,
        source: marketplace.source,
        url: item.productUrl ?? marketplace.sourceUrl,
        fetchedAt: marketplace.fetchedAt,
        fieldName: field,
        fieldValue: value === null ? null : String(value),
        evidenceClass: (value === null ? "unknown" : "actual") as "unknown" | "actual",
        confidence: value === null ? 0 : 0.85,
      }));
      await writeEvidenceBatch(evidenceRows);

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
        const bestsellerId = String(bestseller.id);
        // Concrete supplier-search identifiers (JAN/GTIN/EAN/UPC/MPN)
        // must outrank ASIN-only rows. ASIN is useful for enrichment, but
        // it is not a CJ search key and otherwise starves the bounded
        // supplier batch with rows that cannot be matched directly.
        const hasConcreteSupplierIdentifier = Boolean(
          ids.jan || ids.gtin || ids.ean || ids.upc || ids.mpn,
        );
        if (hasConcreteSupplierIdentifier) bucket.unshift(bestsellerId);
        else bucket.push(bestsellerId);
        supplierCandidateIdsByMarketplace.set(key, bucket);
      }

      if (productId && hasAnyIdentifier(ids)) {
        const identifierRows = Object.entries(ids)
          .filter((entry): entry is [string, string] => Boolean(entry[1]))
          .map(([scheme, value]) => ({
            product_id: productId,
            bestseller_id: bestseller.id,
            scheme,
            value,
            source: marketplace.source,
            fetched_at: marketplace.fetchedAt,
          }));
        if (identifierRows.length > 0) {
          const { error: identifierError } = await supabase
            .from("product_identifiers")
            .upsert(identifierRows, { onConflict: "scheme,value" });
          if (identifierError) throw new Error(identifierError.message);
        }
      }
    }
    if (collectionIndex >= endIndex) break;
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
    canonicalVariantEvidenceSchemaAvailable,
    canonicalVariantEvidenceParsed,
    canonicalVariantEvidenceWritten,
    canonicalVariantEvidenceWriteFailures,
    skippedMarketplaces,
    enrichment: collected.marketplaces
      .filter((marketplace) => marketplace.enrichment)
      .map((marketplace) => ({ marketplace: marketplace.marketplace, ...marketplace.enrichment! })),
    bestsellerIds,
    supplierCandidateIds,
    startIndex,
    processedCount,
    sourceIndex,
    nextIndex: startIndex + processedCount,
    hasMore: startIndex + processedCount < collected.itemCount,
  };
}

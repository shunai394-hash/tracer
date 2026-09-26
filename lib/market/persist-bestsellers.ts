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
  const supplierCandidateIds: string[] = [];
  const skippedMarketplaces = collected.marketplaces
    .filter((item) => item.skipped)
    .map((item) => item.marketplace);

  for (const marketplace of collected.marketplaces) {
    for (const item of marketplace.items) {
      const { data: bestseller, error } = await supabase
        .from("marketplace_bestsellers")
        .insert({
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
        })
        .select("id")
        .single();

      if (error) throw new Error(error.message);
      inserted += 1;
      bestsellerIds.push(String(bestseller.id));

      const identityKey = buildIdentityKey(item.title, item.asin, item.jan, item.gtin, item.mpn);
      let productId: string | null = null;

      const existing = item.asin
        ? await supabase.from("products").select("id").eq("asin", item.asin).maybeSingle()
        : item.jan
          ? await supabase.from("products").select("id").eq("jan", item.jan).maybeSingle()
          : { data: null, error: null };

      if (existing.error) throw new Error(existing.error.message);

      if (existing.data?.id) {
        productId = existing.data.id;
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
      if (hasAnyIdentifier(ids)) {
        supplierCandidateIds.push(String(bestseller.id));
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

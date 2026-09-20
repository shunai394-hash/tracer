import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  assessCanonicalIdentity,
  assessDemandRelevance,
  CANONICAL_LINK_THRESHOLD,
} from "@/lib/intelligence/identity-confidence";
import { assessCurrencyConfidence } from "@/lib/intelligence/currency-confidence";

type PersistDemandCJResult = {
  candidateId: string;
  processed: number;
  productsCreated: number;
  productsReused: number;
  offersCreated: number;
  intelligenceUpserted: number;
  skippedNoise: number;
  identitiesStamped: number;
};

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function persistDemandCJProducts(
  candidateId: string,
  limit = 1,
): Promise<PersistDemandCJResult> {
  const supabase = createSupabaseAdminClient();

  const { data: candidate, error: candidateError } = await supabase
    .from("demand_product_candidates")
    .select("id, query, category, demand_observation_id")
    .eq("id", candidateId)
    .single();

  if (candidateError || !candidate) {
    throw new Error(
      `Demand product candidate not found: ${
        candidateError?.message ?? candidateId
      }`,
    );
  }

  const { data: demandObservation, error: demandError } = await supabase
    .from("demand_observations")
    .select("id, value, signal_type, observed_at, metadata")
    .eq("id", candidate.demand_observation_id)
    .single();

  if (demandError || !demandObservation) {
    throw new Error(
      `Demand observation not found: ${
        demandError?.message ?? candidate.demand_observation_id
      }`,
    );
  }

  const rawDemandValue =
    typeof demandObservation.value === "number"
      ? demandObservation.value
      : Number(demandObservation.value ?? 0);

  const demandSignal = round(clamp(rawDemandValue / 1000));

  const { data: rows, error: rowsError } = await supabase
    .from("demand_cj_products")
    .select(
      "id, demand_product_candidate_id, cj_product_id, title, sku, price, image_url, inventory, listed_num, product_type, sale_status, cj_query",
    )
    .eq("demand_product_candidate_id", candidateId)
    .order("created_at", { ascending: true });

  if (rowsError) {
    throw new Error(`Failed to load CJ products: ${rowsError.message}`);
  }

  const { data: catalog, error: catalogError } = await supabase
    .from("products")
    .select("id, canonical_name, identity_key");

  if (catalogError) {
    throw new Error(`Failed to load products: ${catalogError.message}`);
  }

  const { data: intelligenceRows, error: intelligenceError } = await supabase
    .from("product_intelligence")
    .select("product_id, brand_name");

  if (intelligenceError) {
    throw new Error(
      `Failed to load product intelligence: ${intelligenceError.message}`,
    );
  }

  const brandByProduct = new Map(
    (intelligenceRows ?? []).map((row) => [row.product_id, row.brand_name]),
  );

  let productsCreated = 0;
  let productsReused = 0;
  let offersCreated = 0;
  let intelligenceUpserted = 0;
  let skippedNoise = 0;
  let identitiesStamped = 0;
  let persisted = 0;

  for (const row of rows ?? []) {
    const title = String(row.title ?? "").replace(/\s+/g, " ").trim();

    if (!title) {
      continue;
    }

    const relevance = assessDemandRelevance({
      demandQuery: candidate.query,
      demandCategory: candidate.category,
      title,
      category: row.product_type,
      sku: row.sku,
      imageUrl: row.image_url,
      cjQuery: row.cj_query,
    });

    identitiesStamped += 1;

    if (relevance.status === "rejected_noise") {
      const stamp = await supabase
        .from("demand_cj_products")
        .update({
          product_id: null,
          identity_confidence: relevance.score,
          identity_status: "rejected_noise",
          identity_rationale: relevance.rationale,
          identity_metadata: relevance.signals,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      if (stamp.error) {
        throw new Error(
          `Failed to stamp CJ identity for "${title}": ${stamp.error.message}`,
        );
      }

      skippedNoise += 1;
      continue;
    }

    if (persisted >= Math.max(1, limit)) {
      const stampOnly = await supabase
        .from("demand_cj_products")
        .update({
          identity_confidence: relevance.score,
          identity_status: "unlinked",
          identity_rationale: relevance.rationale,
          identity_metadata: relevance.signals,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      if (stampOnly.error) {
        throw new Error(
          `Failed to stamp CJ identity for "${title}": ${stampOnly.error.message}`,
        );
      }

      continue;
    }

    let productId: string | null = null;
    let linkedExisting = false;

    for (const product of catalog ?? []) {
      const canonical = assessCanonicalIdentity({
        sourceTitle: title,
        sourceSku: row.sku,
        canonicalName: product.canonical_name,
        canonicalBrand: brandByProduct.get(product.id) ?? null,
      });

      if (canonical.score >= CANONICAL_LINK_THRESHOLD) {
        productId = product.id;
        linkedExisting = true;
        break;
      }
    }

    const identityKey = `cj::${row.cj_product_id}`;

    if (!productId) {
      const existingProduct = await supabase
        .from("products")
        .select("id")
        .eq("identity_key", identityKey)
        .maybeSingle();

      if (existingProduct.error) {
        throw new Error(
          `Failed to find CJ product "${row.cj_product_id}": ${existingProduct.error.message}`,
        );
      }

      if (existingProduct.data) {
        productId = existingProduct.data.id;
        productsReused += 1;
      } else {
        const productResult = await supabase
          .from("products")
          .insert({
            brand_id: null,
            canonical_name: title,
            identity_key: identityKey,
          })
          .select("id")
          .single();

        if (productResult.error) {
          throw new Error(
            `Failed to insert CJ product "${title}": ${productResult.error.message}`,
          );
        }

        productId = productResult.data.id;
        productsCreated += 1;
      }
    } else if (linkedExisting) {
      productsReused += 1;
    }

    const stampLinked = await supabase
      .from("demand_cj_products")
      .update({
        product_id: productId,
        identity_confidence: relevance.score,
        identity_status: "linked",
        identity_rationale: linkedExisting
          ? "Linked to an existing canonical product after identity check"
          : "Created or reused a CJ-native canonical product after demand relevance check",
        identity_metadata: relevance.signals,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    if (stampLinked.error) {
      throw new Error(
        `Failed to link CJ product "${title}": ${stampLinked.error.message}`,
      );
    }

    const price = number(row.price);
    const currencyAssessment = assessCurrencyConfidence({
      currency: price !== null ? "USD" : null,
      price,
      provider: "cj",
    });

    const offerResult = await supabase
      .from("product_offers")
      .insert({
        product_id: productId,
        seller_name: "CJdropshipping",
        offer_url: null,
        image_url: row.image_url,
        currency: price !== null ? "USD" : null,
        price,
        currency_confidence: currencyAssessment.confidence,
        availability: row.sale_status,
        shipping_price: null,
        observed_at: new Date().toISOString(),
        metadata: {
          provider: "cj",
          candidate_id: candidate.id,
          demand_query: candidate.query,
          category: candidate.category,
          cj_product_id: row.cj_product_id,
          cj_query: row.cj_query,
          sku: row.sku,
          inventory: row.inventory,
          listed_num: row.listed_num,
          product_type: row.product_type,
          sale_status: row.sale_status,
          demand_observation_id: candidate.demand_observation_id,
          demand_value: rawDemandValue,
          demand_signal: demandSignal,
          currency_confidence: currencyAssessment.confidence,
          currency_confidence_reasons: currencyAssessment.reasons,
          identity_confidence: relevance.score,
          identity_status: "linked",
        },
      })
      .select("id")
      .single();

    if (offerResult.error) {
      throw new Error(
        `Failed to insert CJ offer for "${title}": ${offerResult.error.message}`,
      );
    }

    offersCreated += 1;

    const intelligenceResult = await supabase
      .from("product_intelligence")
      .upsert(
        {
          product_id: productId,
          normalized_title: title,
          brand_name: null,
          category: candidate.category,
          seller_name: "CJdropshipping",
          source_url: null,
          image_url: row.image_url,
          currency: price !== null ? "USD" : null,
          current_price: price,
          price_confidence:
            currencyAssessment.confidence === "high"
              ? 0.9
              : currencyAssessment.confidence === "medium"
                ? 0.6
                : 0.2,
          identity_confidence: relevance.score,
          demand_signal: demandSignal,
          metadata: {
            provider: "cj",
            candidate_id: candidate.id,
            demand_query: candidate.query,
            demand_observation_id: candidate.demand_observation_id,
            demand_value: rawDemandValue,
            demand_signal: demandSignal,
            cj_product_id: row.cj_product_id,
            sku: row.sku,
            inventory: row.inventory,
            listed_num: row.listed_num,
            product_type: row.product_type,
            sale_status: row.sale_status,
            intelligence_source: "demand_cj_products",
            currency_confidence: currencyAssessment.confidence,
            identity_status: "linked",
            identity_rationale: relevance.rationale,
          },
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "product_id" },
      );

    if (intelligenceResult.error) {
      throw new Error(
        `Failed to upsert product intelligence for "${title}": ${intelligenceResult.error.message}`,
      );
    }

    intelligenceUpserted += 1;
    persisted += 1;
  }

  if (offersCreated > 0) {
    const statusUpdate = await supabase
      .from("demand_product_candidates")
      .update({
        status: "offer_found",
        updated_at: new Date().toISOString(),
      })
      .eq("id", candidate.id)
      .in("status", ["new", "researching", "product_found"]);

    if (statusUpdate.error) {
      throw new Error(
        `Failed to update candidate status: ${statusUpdate.error.message}`,
      );
    }
  }

  return {
    candidateId,
    processed: rows?.length ?? 0,
    productsCreated,
    productsReused,
    offersCreated,
    intelligenceUpserted,
    skippedNoise,
    identitiesStamped,
  };
}

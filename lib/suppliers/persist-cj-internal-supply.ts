import "server-only";

import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { identifiersFromRecord, matchProductIdentity, normalizeIdentifier } from "@/lib/market/identifiers";

type CandidateArgs = {
  supplierProductId: string;
  supplierVariantId: string;
  supplierSku?: string | null;
  title: string;
  imageUrl: string;
  barcode?: string | null;
  costUsd: number;
  shippingUsd: number;
  inventory: number;
  fxRate: number;
  sellingPriceJpy: number;
  query: string;
};

function validBarcodeIds(raw: string | null | undefined) {
  const gtin = normalizeIdentifier("gtin", raw);
  const jan = normalizeIdentifier("jan", raw);
  const ean = normalizeIdentifier("ean", raw);
  const upc = normalizeIdentifier("upc", raw);
  return { gtin, jan, ean, upc };
}

/**
 * Persist a live-verified CJ product/variant into the internal supply catalog.
 * A catalog row is scoped to a concrete CJ product+variant so a variant barcode
 * is never promoted to a product-wide identifier for sibling variants.
 *
 * The product is deactivated before source mutation and only reactivated after
 * its variant write succeeds. This path does not publish to Shopify/BASE and
 * does not claim that automated supplier order creation has passed its own gate.
 */
export async function persistCjInternalSupplyCandidate(args: CandidateArgs): Promise<{
  productId: string;
  variantId: string;
  sourceRef: string;
  identityLink: { bestsellerId: string; method: string; rationale: string } | null;
}> {
  if (!args.supplierProductId.trim() || !args.supplierVariantId.trim()) {
    throw new Error("cj_internal_supply_missing_supplier_identity");
  }
  if (!Number.isFinite(args.costUsd) || args.costUsd <= 0
    || !Number.isFinite(args.shippingUsd) || args.shippingUsd <= 0
    || !Number.isFinite(args.inventory) || args.inventory <= 0
    || !Number.isFinite(args.sellingPriceJpy) || args.sellingPriceJpy <= 0) {
    throw new Error("cj_internal_supply_live_commercial_data_invalid");
  }

  const db = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const sourceRef = `cj:${args.supplierProductId}:${args.supplierVariantId}`;
  const ids = validBarcodeIds(args.barcode);
  const identifierValidation = args.barcode?.trim()
    ? Object.values(ids).some(Boolean) ? "valid_gs1_check_digit" : "invalid_format_or_check_digit"
    : "missing";
  const rawBarcode = args.barcode?.trim() || null;

  const productPayload = {
    product_id: null,
    sku: args.supplierSku?.trim() || null,
    title: args.title,
    brand: null,
    ...ids,
    mpn: null,
    cost: args.costUsd,
    shipping_cost: args.shippingUsd,
    currency: "USD",
    inventory: Math.floor(args.inventory),
    lead_time_days: null,
    ship_to: "JP",
    tracking_available: true,
    order_method: "cj_api",
    api_available: true,
    active: false,
    source_name: "cj",
    source_ref: sourceRef,
    metadata: {
      source: "cj_supply_first",
      supplier_product_id: args.supplierProductId,
      supplier_variant_id: args.supplierVariantId,
      supplier_barcode_raw: rawBarcode,
      supplier_barcode_validation: identifierValidation,
      image_url: args.imageUrl,
      query: args.query,
      fx_rate: args.fxRate,
      selling_price_jpy: args.sellingPriceJpy,
      live_stock_and_japan_freight_verified: true,
      automated_order_creation_verified: false,
      sale_gate_note: "Supplier order creation remains subject to the live procurement capability gate.",
    },
    fetched_at: now,
    updated_at: now,
  };

  const existingProduct = await db
    .from("internal_supply_products")
    .select("id")
    .eq("source_name", "cj")
    .eq("source_ref", sourceRef)
    .limit(1)
    .maybeSingle();
  if (existingProduct.error) throw new Error("cj_internal_supply_product_lookup_failed: " + existingProduct.error.message);

  // Check global variant ownership before creating a product row. This avoids
  // leaving orphan inactive product rows when an ID is already attached elsewhere.
  const variantOwners = await db
    .from("internal_supply_variants")
    .select("id,supply_product_id")
    .eq("variant_id", args.supplierVariantId)
    .limit(2);
  if (variantOwners.error) throw new Error("cj_internal_supply_variant_owner_lookup_failed: " + variantOwners.error.message);
  const ownerIds = [...new Set((variantOwners.data ?? []).map((row: { supply_product_id: string }) => String(row.supply_product_id)))];
  if (ownerIds.some((ownerId) => ownerId !== String(existingProduct.data?.id ?? ""))) {
    throw new Error("cj_internal_supply_variant_already_owned_by_another_product");
  }

  const productWrite = existingProduct.data?.id
    ? await db.from("internal_supply_products").update(productPayload).eq("id", existingProduct.data.id).select("id").single()
    : await db.from("internal_supply_products").insert(productPayload).select("id").single();
  if (productWrite.error || !productWrite.data?.id) {
    throw new Error("cj_internal_supply_product_write_failed: " + (productWrite.error?.message ?? "no row returned"));
  }
  const productId = String(productWrite.data.id);

  const variantPayload = {
    supply_product_id: productId,
    variant_sku: args.supplierSku?.trim() || null,
    variant_id: args.supplierVariantId,
    title: args.title,
    ...ids,
    cost: args.costUsd,
    shipping_cost: args.shippingUsd,
    currency: "USD",
    inventory: Math.floor(args.inventory),
    orderable: false,
    tracking_available: true,
    active: true,
    metadata: {
      source: "cj_supply_first",
      supplier_product_id: args.supplierProductId,
      supplier_variant_id: args.supplierVariantId,
      supplier_barcode_raw: rawBarcode,
      supplier_barcode_validation: identifierValidation,
      image_url: args.imageUrl,
      query: args.query,
      fx_rate: args.fxRate,
      selling_price_jpy: args.sellingPriceJpy,
      live_stock_and_japan_freight_verified: true,
      automated_order_creation_verified: false,
      sale_gate_note: "Live inventory and Japan freight are verified, but this variant remains non-orderable until supplier order creation is proven.",
    },
    fetched_at: now,
    updated_at: now,
  };

  const existingVariant = await db
    .from("internal_supply_variants")
    .select("id")
    .eq("supply_product_id", productId)
    .eq("variant_id", args.supplierVariantId)
    .limit(1)
    .maybeSingle();
  if (existingVariant.error) throw new Error("cj_internal_supply_variant_lookup_failed: " + existingVariant.error.message);

  const variantWrite = existingVariant.data?.id
    ? await db.from("internal_supply_variants").update(variantPayload).eq("id", existingVariant.data.id).select("id").single()
    : await db.from("internal_supply_variants").insert(variantPayload).select("id").single();
  if (variantWrite.error || !variantWrite.data?.id) {
    throw new Error("cj_internal_supply_variant_write_failed: " + (variantWrite.error?.message ?? "no row returned"));
  }
  const variantId = String(variantWrite.data.id);

  const activate = await db
    .from("internal_supply_products")
    .update({ active: true, updated_at: new Date().toISOString() })
    .eq("id", productId)
    .select("id")
    .single();
  if (activate.error || !activate.data?.id) {
    throw new Error("cj_internal_supply_product_activation_failed: " + (activate.error?.message ?? "no row returned"));
  }

  // Record a canonical product+variant identity link only for a unique exact
  // barcode match. This evidence is independent of orderability: the variant
  // remains blocked from selling until the live supplier-order contract passes.
  let identityLink: { bestsellerId: string; method: string; rationale: string } | null = null;
  if (Object.values(ids).some(Boolean)) {
    const clauses = ["jan", "gtin", "ean", "upc"]
      .flatMap((column) => Object.entries(ids)
        .filter(([, value]) => Boolean(value))
        .map(([, value]) => `${column}.eq.${value}`))
      .filter((clause, index, all) => all.indexOf(clause) === index);
    const { data: marketRows, error: marketError } = await db
      .from("marketplace_bestsellers")
      .select("id,product_id,jan,gtin,ean,upc,mpn,title,brand")
      .or(clauses.join(","))
      .limit(51);
    if (marketError) {
      console.warn("[cj-internal-supply] exact identity lookup failed", { sourceRef, error: marketError.message });
    } else if ((marketRows ?? []).length <= 50) {
      const matched = (marketRows ?? []).map((row: Record<string, unknown>) => {
        const identity = matchProductIdentity({
          market: { ...identifiersFromRecord(row), brand: typeof row.brand === "string" ? row.brand : null, title: typeof row.title === "string" ? row.title : null },
          supply: { ...identifiersFromRecord({ ...ids, title: args.title }), title: args.title },
        });
        return { row, identity };
      }).filter((item) => item.identity.salesEligible);
      if (matched.length === 1) {
        const row = matched[0].row;
        const linkPayload = {
          bestseller_id: String(row.id),
          supply_product_id: productId,
          supply_variant_id: variantId,
          identity_method: matched[0].identity.method,
          identity_confidence: matched[0].identity.confidence,
          identity_rationale: matched[0].identity.rationale,
          status: "verified",
        };
        const link = await db.from("internal_supply_links").insert(linkPayload);
        if (!link.error || /duplicate|unique/i.test(link.error.message)) {
          identityLink = {
            bestsellerId: String(row.id),
            method: matched[0].identity.method,
            rationale: matched[0].identity.rationale,
          };
        } else {
          console.warn("[cj-internal-supply] identity link persistence failed", { sourceRef, error: link.error.message });
        }
      }
    }
  }

  // Audit is best-effort for compatibility with databases that have not yet
  // applied the PR #152 migration. Its absence must not hide the source write.
  const audit = await db.from("internal_supply_ingestion_audit").insert({
    request_id: randomUUID(),
    item_index: 0,
    source_name: "cj",
    source_ref: sourceRef,
    outcome: "draft_ingested",
    product_id: productId,
    submitted_variant_count: 1,
    written_variant_ids: [variantId],
    error_codes: [],
    details: {
      supplier_product_id: args.supplierProductId,
      supplier_variant_id: args.supplierVariantId,
      supplier_barcode_raw: rawBarcode,
      supplier_barcode_validation: identifierValidation,
      order_creation_verified: false,
      identity_link: identityLink,
    },
  });
  if (audit.error) {
    console.warn("[cj-internal-supply] audit table unavailable or write failed", {
      sourceRef,
      error: audit.error.message,
    });
  }

  return { productId, variantId, sourceRef, identityLink };
}

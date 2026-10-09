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
  auditStatus: "written" | "table_missing" | "write_failed";
  identityMatchStatus: "linked" | "missing_barcode" | "invalid_barcode" | "lookup_failed" | "candidate_search_overflow" | "no_exact_match" | "ambiguous_exact_match" | "link_write_failed";
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
  const freshIds = validBarcodeIds(args.barcode);
  let ids = freshIds;
  const identifierValidation = args.barcode?.trim()
    ? Object.values(freshIds).some(Boolean) ? "valid_gs1_check_digit" : "invalid_format_or_check_digit"
    : "missing";
  const rawBarcode = args.barcode?.trim() || null;

  const productPayload = {
    product_id: null,
    // Keep supplier SKU on the concrete variant row; it may repeat across variants.
    // Production has a unique (source_name, sku) key on internal products.
    sku: null,
    title: args.title,
    brand: null,
    // This internal product row is intentionally scoped to the concrete CJ product+variant
    // by source_ref, so these identity fields describe only this one variant. Keeping the
    // verified barcode here as well as on the variant is required by the existing catalog
    // resolver, which first locates the active internal product by identifier before it
    // validates the exact request-scoped variant row. It does not copy identity to siblings.
    gtin: ids.gtin,
    jan: ids.jan,
    ean: ids.ean,
    upc: ids.upc,
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
      supplier_sku: args.supplierSku?.trim() || null,
      supplier_barcode_raw: rawBarcode,
      supplier_barcode_validation: identifierValidation,
      supplier_identifier_evidence_source: Object.values(freshIds).some(Boolean) ? "fresh_live_barcode" : "none",
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
    .select("id,gtin,jan,ean,upc")
    .eq("source_name", "cj")
    .eq("source_ref", sourceRef)
    .limit(1)
    .maybeSingle();
  if (existingProduct.error) throw new Error("cj_internal_supply_product_lookup_failed: " + existingProduct.error.message);

  // A temporary missing/invalid live barcode must not erase previously verified
  // identity evidence on an idempotent refresh. Prefer the concrete variant row,
  // then its variant-scoped product row; never mix identifiers from two barcodes.
  const existingVariant = existingProduct.data?.id
    ? await db
      .from("internal_supply_variants")
      .select("jan,gtin,ean,upc")
      .eq("supply_product_id", String(existingProduct.data.id))
      .eq("variant_id", args.supplierVariantId)
      .maybeSingle()
    : null;
  if (existingVariant?.error) throw new Error("cj_internal_supply_existing_variant_lookup_failed: " + existingVariant.error.message);
  const previousIds = {
    gtin: normalizeIdentifier("gtin", existingVariant?.data?.gtin ?? existingProduct.data?.gtin ?? null),
    jan: normalizeIdentifier("jan", existingVariant?.data?.jan ?? existingProduct.data?.jan ?? null),
    ean: normalizeIdentifier("ean", existingVariant?.data?.ean ?? existingProduct.data?.ean ?? null),
    upc: normalizeIdentifier("upc", existingVariant?.data?.upc ?? existingProduct.data?.upc ?? null),
  };
  ids = Object.values(freshIds).some(Boolean) ? freshIds : previousIds;
  const identifierEvidenceSource = Object.values(freshIds).some(Boolean)
    ? "fresh_live_barcode"
    : Object.values(ids).some(Boolean) ? "preserved_prior_valid_identifier" : "none";

  // productPayload is initialized before the prior row can be read. Refresh its
  // identifier fields only after choosing the complete fresh-or-preserved set,
  // otherwise a missing/invalid live barcode would still erase product-level IDs.
  productPayload.gtin = ids.gtin;
  productPayload.jan = ids.jan;
  productPayload.ean = ids.ean;
  productPayload.upc = ids.upc;
  productPayload.metadata.supplier_identifier_evidence_source = identifierEvidenceSource;

  // Check CJ-scoped variant ownership before creating a product row. A database
  // unique index is the final race-safe guard; this precheck improves diagnostics.
  const variantOwners = await db
    .from("internal_supply_variants")
    .select("id,supply_product_id,source_name")
    .eq("source_name", "cj")
    .eq("variant_id", args.supplierVariantId)
    .limit(2);
  if (variantOwners.error) throw new Error("cj_internal_supply_variant_owner_lookup_failed: " + variantOwners.error.message);
  const ownerIds = [...new Set((variantOwners.data ?? []).map((row: { supply_product_id: string; source_name: string }) => String(row.supply_product_id)))];
  if (ownerIds.some((ownerId) => ownerId !== String(existingProduct.data?.id ?? ""))) {
    throw new Error("cj_internal_supply_variant_already_owned_by_another_product");
  }

  // Use the stable source key as the database-enforced idempotency key. A
  // lookup-then-insert alone races when two cron invocations see no row.
  const productWrite = await db
    .from("internal_supply_products")
    .upsert(productPayload, { onConflict: "source_name,source_ref" })
    .select("id")
    .single();
  if (productWrite.error || !productWrite.data?.id) {
    throw new Error("cj_internal_supply_product_write_failed: " + (productWrite.error?.message ?? "no row returned"));
  }
  const productId = String(productWrite.data.id);

  const variantPayload = {
    source_name: "cj",
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
      supplier_identifier_evidence_source: identifierEvidenceSource,
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

  // The full unique conflict target is added by the companion migration.
  // This makes retries idempotent and avoids duplicate rows on concurrent runs.
  const variantWrite = await db
    .from("internal_supply_variants")
    .upsert(variantPayload, { onConflict: "supply_product_id,variant_id" })
    .select("id")
    .single();
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
  let identityMatchStatus: "linked" | "missing_barcode" | "invalid_barcode" | "lookup_failed" | "candidate_search_overflow" | "no_exact_match" | "ambiguous_exact_match" | "link_write_failed" = Object.values(ids).some(Boolean)
    ? "no_exact_match"
    : rawBarcode ? "invalid_barcode" : "missing_barcode";
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
      identityMatchStatus = "lookup_failed";
      console.warn("[cj-internal-supply] exact identity lookup failed", { sourceRef, error: marketError.message });
    } else if ((marketRows ?? []).length > 50) {
      identityMatchStatus = "candidate_search_overflow";
    } else {
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
        if (!link.error) {
          identityMatchStatus = "linked";
          identityLink = {
            bestsellerId: String(row.id),
            method: matched[0].identity.method,
            rationale: matched[0].identity.rationale,
          };
        } else if (/duplicate|unique/i.test(link.error.message)) {
          // A unique violation alone does not prove that the existing row is the
          // same reviewed identity evidence. Only treat it as an idempotent retry
          // when the exact relationship and evidence already persisted match.
          const existingLink = await db
            .from("internal_supply_links")
            .select("identity_method,identity_confidence,identity_rationale,status")
            .eq("bestseller_id", linkPayload.bestseller_id)
            .eq("supply_product_id", linkPayload.supply_product_id)
            .eq("supply_variant_id", linkPayload.supply_variant_id)
            .maybeSingle();
          const sameEvidence = !existingLink.error
            && existingLink.data?.status === "verified"
            && existingLink.data?.identity_method === linkPayload.identity_method
            && Number(existingLink.data?.identity_confidence) === linkPayload.identity_confidence
            && existingLink.data?.identity_rationale === linkPayload.identity_rationale;
          if (sameEvidence) {
            identityMatchStatus = "linked";
            identityLink = {
              bestsellerId: String(row.id),
              method: matched[0].identity.method,
              rationale: matched[0].identity.rationale,
            };
          } else {
            identityMatchStatus = "link_write_failed";
            console.warn("[cj-internal-supply] identity link duplicate did not match intended evidence", {
              sourceRef,
              error: link.error.message,
              existingError: existingLink.error?.message ?? null,
            });
          }
        } else {
          identityMatchStatus = "link_write_failed";
          console.warn("[cj-internal-supply] identity link persistence failed", { sourceRef, error: link.error.message });
        }
      } else if (matched.length > 1) {
        identityMatchStatus = "ambiguous_exact_match";
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
      supplier_identifier_evidence_source: identifierEvidenceSource,
      order_creation_verified: false,
      identity_link: identityLink,
      identity_match_status: identityMatchStatus,
    },
  });
  const auditErrorCode = typeof audit.error?.code === "string" ? audit.error.code : "";
  const auditErrorMessage = audit.error?.message ?? "";
  const auditTableMissing = Boolean(audit.error) && (
    auditErrorCode === "42P01"
    || auditErrorCode === "PGRST205"
    || /relation .* does not exist|could not find the table .*schema cache/i.test(auditErrorMessage)
  );
  const auditStatus: "written" | "table_missing" | "write_failed" = !audit.error
    ? "written"
    : auditTableMissing ? "table_missing" : "write_failed";
  if (audit.error) {
    console.warn("[cj-internal-supply] audit persistence failed", {
      sourceRef,
      status: auditStatus,
      code: auditErrorCode || null,
      error: auditErrorMessage,
    });
  }

  return { productId, variantId, sourceRef, identityLink, identityMatchStatus, auditStatus };
}

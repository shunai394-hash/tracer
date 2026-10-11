/**
 * Pure contracts for the isolated TRACER commerce-core refactor.
 *
 * No network, database, or provider calls belong in this module. These
 * functions only classify input and are safe to use in dry-run tooling.
 */

export type IdentityRecord = {
  internalProductId: string;
  supplierListingId?: string | null;
  supplierProductId?: string | null;
  supplierVariantId?: string | null;
  channel?: "base" | "shopify";
  channelProductId?: string | null;
  sku?: string | null;
};

export type IdentityResolution =
  | { status: "matched"; internalProductId: string; evidence: "supplier_variant" | "channel_product" }
  | { status: "unmatched"; reason: "missing_external_identity" | "no_exact_match" }
  | { status: "conflict"; reason: "multiple_exact_matches"; candidateProductIds: string[] };

/**
 * Resolves only exact stable external identities. SKU/title/image similarity
 * is deliberately insufficient to merge products automatically.
 */
export function resolveProductIdentity(
  input: Pick<IdentityRecord, "supplierProductId" | "supplierVariantId" | "channel" | "channelProductId">,
  records: IdentityRecord[],
): IdentityResolution {
  const supplierProductId = clean(input.supplierProductId);
  const supplierVariantId = clean(input.supplierVariantId);
  const channel = input.channel;
  const channelProductId = clean(input.channelProductId);

  if (!((supplierProductId && supplierVariantId) || (channel && channelProductId))) {
    return { status: "unmatched", reason: "missing_external_identity" };
  }

  const matches = records.filter((record) => {
    const supplierMatch = Boolean(
      supplierProductId &&
      supplierVariantId &&
      clean(record.supplierProductId) === supplierProductId &&
      clean(record.supplierVariantId) === supplierVariantId,
    );
    const channelMatch = Boolean(
      channel &&
      channelProductId &&
      record.channel === channel &&
      clean(record.channelProductId) === channelProductId,
    );
    return supplierMatch || channelMatch;
  });

  const productIds = [...new Set(matches.map((record) => clean(record.internalProductId)).filter(Boolean))];
  if (productIds.length === 0) return { status: "unmatched", reason: "no_exact_match" };
  if (productIds.length > 1) {
    return { status: "conflict", reason: "multiple_exact_matches", candidateProductIds: productIds.sort() };
  }

  const evidence = matches.some((record) =>
    supplierProductId &&
    supplierVariantId &&
    clean(record.supplierProductId) === supplierProductId &&
    clean(record.supplierVariantId) === supplierVariantId,
  ) ? "supplier_variant" : "channel_product";

  return { status: "matched", internalProductId: productIds[0], evidence };
}

export type PublicationEvidence = {
  salesTestPassed: boolean;
  japaneseTitleValid: boolean;
  descriptionValid: boolean;
  imageVerified: boolean;
  supplierIdentityVerified: boolean;
  supplierVariantVerified: boolean;
  inventoryKnown: boolean;
  inventoryAvailable: number | null;
  orderable: boolean;
  trackingAvailable: boolean;
  sellingPrice: number | null;
  landedCost: number | null;
  channelFees: number | null;
  shippingCost: number | null;
};

export type PublicationDecision = {
  eligible: boolean;
  blockers: string[];
  expectedUnitMargin: number | null;
};

/** Pure, fail-closed policy; unknown values are blockers, never zero-cost defaults. */
export function evaluatePublication(evidence: PublicationEvidence): PublicationDecision {
  const blockers: string[] = [];
  if (!evidence.salesTestPassed) blockers.push("sales_test_not_passed");
  if (!evidence.japaneseTitleValid) blockers.push("japanese_title_invalid");
  if (!evidence.descriptionValid) blockers.push("description_invalid");
  if (!evidence.imageVerified) blockers.push("image_not_verified");
  if (!evidence.supplierIdentityVerified) blockers.push("supplier_identity_unverified");
  if (!evidence.supplierVariantVerified) blockers.push("supplier_variant_unverified");
  if (!evidence.inventoryKnown || evidence.inventoryAvailable === null || !Number.isFinite(evidence.inventoryAvailable)) {
    blockers.push("inventory_unknown");
  } else if (evidence.inventoryAvailable <= 0) {
    blockers.push("inventory_unavailable");
  }
  if (!evidence.orderable) blockers.push("supplier_not_orderable");
  if (!evidence.trackingAvailable) blockers.push("tracking_unavailable");

  const costs = [evidence.sellingPrice, evidence.landedCost, evidence.channelFees, evidence.shippingCost];
  if (costs.some((value) => value === null || !Number.isFinite(value))) {
    blockers.push("cost_or_price_unknown");
  } else {
    const [price, landed, fees, shipping] = costs as number[];
    if (price <= 0 || landed < 0 || fees < 0 || shipping < 0) {
      blockers.push("cost_or_price_invalid");
    }
  }

  const expectedUnitMargin = costs.every((value) => value !== null && Number.isFinite(value))
    ? (evidence.sellingPrice as number) - (evidence.landedCost as number) - (evidence.channelFees as number) - (evidence.shippingCost as number)
    : null;
  if (expectedUnitMargin !== null && expectedUnitMargin <= 0) blockers.push("non_positive_unit_margin");

  return { eligible: blockers.length === 0, blockers, expectedUnitMargin };
}

export type OrderAttemptState = "none" | "received" | "processing" | "submitted" | "confirmed" | "failed" | "unknown";
export type OrderDisposition =
  | { action: "process"; reason: "new_order" }
  | { action: "skip"; reason: "already_submitted_or_confirmed" }
  | { action: "reconcile"; reason: "ambiguous_or_in_progress_attempt" }
  | { action: "retry_after_review"; reason: "previous_attempt_failed" }
  | { action: "block"; reason: "missing_external_order_identity" };

/** Classifies retries; does not place orders or mutate state. */
export function classifyOrderAttempt(
  channel: string | null | undefined,
  externalOrderId: string | null | undefined,
  attempt: OrderAttemptState,
): OrderDisposition {
  if (!clean(channel) || !clean(externalOrderId)) {
    return { action: "block", reason: "missing_external_order_identity" };
  }
  if (attempt === "submitted" || attempt === "confirmed") {
    return { action: "skip", reason: "already_submitted_or_confirmed" };
  }
  if (attempt === "processing" || attempt === "unknown") {
    return { action: "reconcile", reason: "ambiguous_or_in_progress_attempt" };
  }
  if (attempt === "failed") {
    return { action: "retry_after_review", reason: "previous_attempt_failed" };
  }
  return { action: "process", reason: "new_order" };
}

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

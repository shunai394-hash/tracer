export type IdentityRecord = {
  internalProductId: string;
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

export function resolveProductIdentity(
  input: Pick<IdentityRecord, "supplierProductId" | "supplierVariantId" | "channel" | "channelProductId">,
  records: IdentityRecord[],
): IdentityResolution {
  const product = clean(input.supplierProductId);
  const variant = clean(input.supplierVariantId);
  const channel = input.channel;
  const channelId = clean(input.channelProductId);
  if (!(product && variant) && !(channel && channelId)) return { status: "unmatched", reason: "missing_external_identity" };
  const matches = records.filter((row) =>
    Boolean(product && variant && clean(row.supplierProductId) === product && clean(row.supplierVariantId) === variant) ||
    Boolean(channel && channelId && row.channel === channel && clean(row.channelProductId) === channelId),
  );
  const ids = [...new Set(matches.map((row) => clean(row.internalProductId)).filter(Boolean))].sort();
  if (!ids.length) return { status: "unmatched", reason: "no_exact_match" };
  if (ids.length > 1) return { status: "conflict", reason: "multiple_exact_matches", candidateProductIds: ids };
  const supplierEvidence = matches.some((row) => product && variant && clean(row.supplierProductId) === product && clean(row.supplierVariantId) === variant);
  return { status: "matched", internalProductId: ids[0], evidence: supplierEvidence ? "supplier_variant" : "channel_product" };
}

/** Publication and order execution are separate, but listing safety still requires a sellable, fulfillable offer. */
export type PublicationEvidence = {
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
export type PublicationDecision = { eligible: boolean; blockers: string[]; expectedUnitMargin: number | null };
export function evaluatePublication(e: PublicationEvidence): PublicationDecision {
  const blockers: string[] = [];
  if (!e.japaneseTitleValid) blockers.push("japanese_title_invalid");
  if (!e.descriptionValid) blockers.push("description_invalid");
  if (!e.imageVerified) blockers.push("image_not_verified");
  if (!e.supplierIdentityVerified) blockers.push("supplier_identity_unverified");
  if (!e.supplierVariantVerified) blockers.push("supplier_variant_unverified");
  if (!e.inventoryKnown || e.inventoryAvailable === null || !Number.isFinite(e.inventoryAvailable)) blockers.push("inventory_unknown");
  else if (e.inventoryAvailable <= 0) blockers.push("inventory_unavailable");
  if (!e.orderable) blockers.push("supplier_not_orderable");
  if (!e.trackingAvailable) blockers.push("tracking_unavailable");
  const values = [e.sellingPrice, e.landedCost, e.channelFees, e.shippingCost];
  if (values.some((v) => v === null || !Number.isFinite(v))) blockers.push("cost_or_price_unknown");
  else if ((e.sellingPrice as number) <= 0 || (e.landedCost as number) < 0 || (e.channelFees as number) < 0 || (e.shippingCost as number) < 0) blockers.push("cost_or_price_invalid");
  const expectedUnitMargin = values.every((v) => v !== null && Number.isFinite(v))
    ? (e.sellingPrice as number) - (e.landedCost as number) - (e.channelFees as number) - (e.shippingCost as number)
    : null;
  if (expectedUnitMargin !== null && expectedUnitMargin <= 0) blockers.push("non_positive_unit_margin");
  return { eligible: blockers.length === 0, blockers, expectedUnitMargin };
}

export type OrderExecutionEvidence = {
  supplierIdentityVerified: boolean;
  supplierVariantVerified: boolean;
  inventoryKnown: boolean;
  inventoryAvailable: number | null;
  orderable: boolean;
  trackingAvailable: boolean;
};
export type OrderExecutionDecision = { eligible: boolean; blockers: string[] };
export function evaluateOrderExecution(e: OrderExecutionEvidence): OrderExecutionDecision {
  const blockers: string[] = [];
  if (!e.supplierIdentityVerified) blockers.push("supplier_identity_unverified");
  if (!e.supplierVariantVerified) blockers.push("supplier_variant_unverified");
  if (!e.inventoryKnown || e.inventoryAvailable === null || !Number.isFinite(e.inventoryAvailable)) blockers.push("inventory_unknown");
  else if (e.inventoryAvailable <= 0) blockers.push("inventory_unavailable");
  if (!e.orderable) blockers.push("supplier_not_orderable");
  if (!e.trackingAvailable) blockers.push("tracking_unavailable");
  return { eligible: blockers.length === 0, blockers };
}

export type OrderAttemptState = "none" | "received" | "processing" | "submitted" | "confirmed" | "failed" | "unknown";
export type OrderDisposition =
  | { action: "process"; reason: "new_order" }
  | { action: "skip"; reason: "already_submitted_or_confirmed" }
  | { action: "reconcile"; reason: "ambiguous_or_in_progress_attempt" }
  | { action: "retry_after_review"; reason: "previous_attempt_failed" }
  | { action: "block"; reason: "missing_external_order_identity" };
export function classifyOrderAttempt(channel: string | null | undefined, externalOrderId: string | null | undefined, state: OrderAttemptState): OrderDisposition {
  if (!clean(channel) || !clean(externalOrderId)) return { action: "block", reason: "missing_external_order_identity" };
  if (state === "submitted" || state === "confirmed") return { action: "skip", reason: "already_submitted_or_confirmed" };
  if (state === "processing" || state === "unknown") return { action: "reconcile", reason: "ambiguous_or_in_progress_attempt" };
  if (state === "failed") return { action: "retry_after_review", reason: "previous_attempt_failed" };
  return { action: "process", reason: "new_order" };
}
function clean(value: string | null | undefined): string { return typeof value === "string" ? value.trim() : ""; }

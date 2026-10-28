export type RoleName = "main" | "product_monitor" | "japanese_localization" | "channel_sync" | "qa";

export type Evidence = {
  supplierProductId?: string | null;
  supplierVariantId?: string | null;
  stock?: number | null;
  supplierCost?: number | null;
  japanShipping?: number | null;
  observedAt?: string | null;
  japaneseTitle?: string | null;
  positiveProfit?: boolean | null;
  trackingAvailable?: boolean | null;
};

export type ListingSnapshot = {
  id: string;
  price?: number | null;
  inventory?: number | null;
  published?: boolean | null;
  sku?: string | null;
  variantId?: string | null;
  title?: string | null;
  description?: string | null;
};

export type FieldDiff = {
  field: string;
  canonical: unknown;
  channel: unknown;
};

const PROTECTED_LOCALIZATION_FIELDS = [
  "id", "price", "inventory", "published", "sku", "variantId",
  "supplierProductId", "supplierVariantId", "image", "images",
] as const;

export function evaluateSellability(evidence: Evidence, now = new Date(), maxAgeMs = 30 * 60 * 1000) {
  const missing: string[] = [];
  if (!evidence.supplierProductId?.trim()) missing.push("supplierProductId");
  if (!evidence.supplierVariantId?.trim()) missing.push("supplierVariantId");
  if (typeof evidence.stock !== "number" || !Number.isFinite(evidence.stock) || evidence.stock <= 0) missing.push("positiveStock");
  if (typeof evidence.supplierCost !== "number" || !Number.isFinite(evidence.supplierCost) || evidence.supplierCost <= 0) missing.push("supplierCost");
  if (typeof evidence.japanShipping !== "number" || !Number.isFinite(evidence.japanShipping) || evidence.japanShipping < 0) missing.push("japanShipping");
  if (evidence.positiveProfit !== true) missing.push("positiveProfit");
  if (evidence.trackingAvailable !== true) missing.push("trackingAvailable");
  if (!evidence.japaneseTitle?.trim() || !/[\u3040-\u30ff\u3400-\u9fff]/u.test(evidence.japaneseTitle)) missing.push("japaneseTitle");
  const observedAt = evidence.observedAt ? Date.parse(evidence.observedAt) : NaN;
  if (!Number.isFinite(observedAt) || observedAt > now.getTime() || now.getTime() - observedAt > maxAgeMs) missing.push("freshEvidence");
  return { sellable: missing.length === 0, missing };
}

export function buildLocalizationPatch(draft: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  if (typeof draft.title === "string" && draft.title.trim()) patch.title = draft.title.trim();
  if (typeof draft.description === "string" && draft.description.trim()) patch.description = draft.description.trim();
  if (typeof draft.variantText === "string" && draft.variantText.trim()) patch.variantText = draft.variantText.trim();
  const rejectedFields = Object.keys(draft).filter((key) =>
    (PROTECTED_LOCALIZATION_FIELDS as readonly string[]).includes(key),
  );
  return { patch, rejectedFields };
}

export function diffChannelSnapshot(canonical: ListingSnapshot, channel: ListingSnapshot) {
  const fields = ["price", "inventory", "published", "sku", "variantId", "title", "description"] as const;
  const differences: FieldDiff[] = [];
  for (const field of fields) {
    if (canonical[field] !== channel[field]) {
      differences.push({ field, canonical: canonical[field] ?? null, channel: channel[field] ?? null });
    }
  }
  return { listingId: canonical.id, channelListingId: channel.id, matches: differences.length === 0, differences };
}

export function buildRoleReport(input: {
  runId: string;
  role: RoleName;
  scanned: number;
  changed: number;
  failed: number;
  skipped: number;
  evidenceRefs?: string[];
  writesPerformed?: boolean;
  notes?: string[];
}) {
  const counts = [input.scanned, input.changed, input.failed, input.skipped];
  if (!input.runId.trim() || counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("invalid_role_report");
  }
  return {
    runId: input.runId,
    role: input.role,
    status: input.failed > 0 ? "attention_required" : input.changed > 0 ? "changed" : "NOOP",
    counts: { scanned: input.scanned, changed: input.changed, failed: input.failed, skipped: input.skipped },
    evidenceRefs: (input.evidenceRefs ?? []).filter((ref) => typeof ref === "string" && ref.trim()).slice(0, 100),
    writesPerformed: input.writesPerformed === true,
    notes: (input.notes ?? []).slice(0, 20),
    generatedAt: new Date().toISOString(),
  };
}

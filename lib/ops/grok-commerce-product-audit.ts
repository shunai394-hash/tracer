import type { Evidence, ListingSnapshot } from "./grok-commerce-role-contracts.ts";
import { evaluateSellability } from "./grok-commerce-role-contracts.ts";

export const REQUIRED_COMMERCE_CHANNELS = ["BASE", "Shopify", "NEWFIND"] as const;

export type ProductAuditInput = {
  productId: string;
  evidence: Evidence;
  canonical?: ListingSnapshot | null;
  channels?: Array<{ channel: string; listing: ListingSnapshot | null }>;
  description?: string | null;
};

export type ProductAuditIssue = {
  code: string;
  severity: "error" | "warning";
  detail: string;
};

const hasJapanese = (value: unknown) =>
  typeof value === "string" && /[\u3040-\u30ff\u3400-\u9fff]/u.test(value);

export function auditCommerceProduct(input: ProductAuditInput, now = new Date()) {
  const issues: ProductAuditIssue[] = [];
  const sellability = evaluateSellability(input.evidence, now);
  for (const missing of sellability.missing) {
    issues.push({
      code: `sellability_missing_${missing}`,
      severity: "error",
      detail: `Sellability evidence missing or invalid: ${missing}`,
    });
  }

  if (!hasJapanese(input.evidence.japaneseTitle)) {
    issues.push({
      code: "japanese_title_required",
      severity: "warning",
      detail: "Japanese title is missing or contains no Japanese characters.",
    });
  }
  if (input.description && !hasJapanese(input.description)) {
    issues.push({
      code: "japanese_description_review",
      severity: "warning",
      detail: "Description contains no Japanese characters; review localization.",
    });
  }

  const seenChannels = new Set<string>();
  const channelEntries = input.channels ?? [];
  for (const requiredChannel of REQUIRED_COMMERCE_CHANNELS) {
    if (!channelEntries.some((entry) => entry.channel === requiredChannel)) {
      issues.push({
        code: `channel_listing_missing_${requiredChannel}`,
        severity: "error",
        detail: `No listing snapshot was supplied for required channel ${requiredChannel}.`,
      });
    }
  }
  for (const entry of channelEntries) {
    if (seenChannels.has(entry.channel)) {
      issues.push({
        code: `duplicate_channel_snapshot_${entry.channel}`,
        severity: "error",
        detail: `More than one listing snapshot was supplied for ${entry.channel}.`,
      });
      continue;
    }
    seenChannels.add(entry.channel);
    if (!entry.listing) {
      issues.push({
        code: `channel_listing_missing_${entry.channel}`,
        severity: "error",
        detail: `No listing snapshot was supplied for ${entry.channel}.`,
      });
      continue;
    }
    if (!entry.listing.id?.trim()) {
      issues.push({
        code: `channel_external_id_missing_${entry.channel}`,
        severity: "error",
        detail: `Listing snapshot for ${entry.channel} has no external ID.`,
      });
    }
    if (typeof entry.listing.title !== "string" || !hasJapanese(entry.listing.title)) {
      issues.push({
        code: `channel_title_not_japanese_${entry.channel}`,
        severity: "warning",
        detail: `Listing title on ${entry.channel} is missing or not Japanese.`,
      });
    }
    if (input.canonical) {
      const fields = ["price", "inventory", "published", "sku", "variantId"] as const;
      for (const field of fields) {
        if (input.canonical[field] !== entry.listing[field]) {
          issues.push({
            code: `channel_parity_mismatch_${entry.channel}_${field}`,
            severity: "warning",
            detail: `Canonical and ${entry.channel} values differ for ${field}.`,
          });
        }
      }
    }
  }

  return {
    productId: input.productId,
    sellable: sellability.sellable,
    issueCount: issues.length,
    issues,
    readOnly: true as const,
    writesPerformed: false as const,
  };
}

export function auditCommerceProducts(inputs: ProductAuditInput[], now = new Date()) {
  const reports = inputs.map((input) => auditCommerceProduct(input, now));
  return {
    scanned: reports.length,
    withIssues: reports.filter((report) => report.issueCount > 0).length,
    unsellable: reports.filter((report) => !report.sellable).length,
    issueCounts: reports.reduce<Record<string, number>>((counts, report) => {
      for (const issue of report.issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
      return counts;
    }, {}),
    reports,
    readOnly: true as const,
    writesPerformed: false as const,
  };
}

import "server-only";

export type PatrolFinding = {
  key: string;
  severity: "info" | "warning" | "critical";
  evidence: Record<string, unknown>;
};

export type PatrolDecision = {
  diagnosis: string;
  actions: Array<"supply-first" | "base-publish" | "inventory-refresh" | "supplier-investigation" | "none">;
  reason: string;
  confidence: number;
};

/** Deterministic safety layer: the AI may choose only from bounded repair actions. */
export function diagnosePatrol(input: {
  orderable: number;
  due: number;
  retryable: number;
  basePublished: number;
  publishedOrderable: number;
  products: number;
}): PatrolDecision {
  if (input.orderable === 0 && (input.due > 0 || input.retryable > 0)) {
    return { diagnosis: "supplier_verification_block", actions: ["supply-first"], reason: "No orderable supply while CJ verification work is available.", confidence: 0.99 };
  }
  if (input.orderable > 0 && input.basePublished === 0) {
    return { diagnosis: "base_publication_gap", actions: ["base-publish"], reason: "Verified orderable supply exists but BASE has no published listing.", confidence: 0.99 };
  }
  if (input.publishedOrderable === 0 && input.basePublished > 0) {
    return { diagnosis: "published_inventory_gap", actions: ["inventory-refresh", "supply-first"], reason: "BASE listings exist but no published listing has confirmed sellable inventory.", confidence: 0.95 };
  }
  if (input.products === 0) {
    return { diagnosis: "product_funnel_empty", actions: ["supply-first"], reason: "The product funnel is empty; sourcing must advance before publication.", confidence: 1 };
  }
  return { diagnosis: "healthy_or_unclassified", actions: ["none"], reason: "No bounded repair condition was detected.", confidence: 0.8 };
}

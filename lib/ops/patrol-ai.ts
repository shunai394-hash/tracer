import "server-only";

export type PatrolAudit = {
  counts?: Record<string, number | string>;
  shopListingBlockedReasons?: Record<string, number>;
  recentPublished?: Array<Record<string, unknown>>;
};

export type PatrolDecision = {
  action: "repair_first_cj" | "run_supply_first" | "observe";
  reason: string;
};

export function decidePatrolAction(audit: PatrolAudit): PatrolDecision {
  const c = audit.counts ?? {};
  const published = Number(c.shop_listings_published ?? 0);
  const publishedOrderable = Number(c.shop_listings_published_orderable ?? 0);
  const cjVariants = Number(c.cj_with_variant ?? 0);
  const cjVerified = Number(c.cj_verified ?? 0);
  const cjRetryable = Number(c.cj_retryable ?? 0);

  const first = audit.recentPublished?.find((row) =>
    String(row.base_item_id ?? "").length > 0 &&
    String(row.pipeline_reason ?? "").toLowerCase().includes("inventory")
  );

  if (first && cjVariants > 0 && publishedOrderable === 0) {
    return {
      action: "repair_first_cj",
      reason: "Published CJ supply exists but the published funnel has no orderable listing; refresh live CJ inventory/freight before creating more supply.",
    };
  }

  if (published === 0 || (publishedOrderable === 0 && cjVariants === 0) || cjRetryable > cjVerified) {
    return {
      action: "run_supply_first",
      reason: "The supply funnel has insufficient verified/orderable CJ supply; run a bounded supply-first patrol.",
    };
  }

  return {
    action: "observe",
    reason: "No safe automatic repair condition is currently met; continue monitoring without mutating inventory or orders.",
  };
}

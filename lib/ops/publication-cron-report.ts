export type PublicationChannelResult = {
  error?: string;
  configured?: boolean;
  failed?: number | Array<unknown>;
  errors?: Array<{ listingId: string; error: string }>;
  results?: Array<{ ok: boolean; skipped?: boolean; error?: string }>;
};

export type PublicationDownstreamReport = {
  ok: boolean;
  httpStatus: number;
  cronStatus: "succeeded" | "partial" | "failed";
  failed: number;
  shopifyFailures: number;
  baseFailures: number;
  reasons: string[];
};

function countedFailures(value: number | Array<unknown> | undefined): number {
  if (Array.isArray(value)) return value.length;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function shopifyFailures(shopify: PublicationChannelResult): number {
  const listed = Math.max(shopify.errors?.length ?? 0, countedFailures(shopify.failed));
  if (typeof shopify.error === "string" && shopify.error) return Math.max(1, listed);
  if (shopify.configured === false) return Math.max(1, listed);
  return listed;
}

function baseFailures(base: PublicationChannelResult): number {
  if (typeof base.error === "string" && base.error) return Math.max(1, base.results?.filter((item) => !item.ok && !item.skipped).length ?? 1);
  return base.results?.filter((item) => !item.ok && !item.skipped).length ?? 0;
}

/**
 * A counted job is succeeded only when work failures and the ledger write
 * both succeed. Partial work stays partial. A ledger failure is failed.
 */
export function assessCountedCronResult(input: {
  processed: number;
  failed: number;
  ledgerUpdateFailed?: boolean;
}): { ok: boolean; httpStatus: number; cronStatus: "succeeded" | "partial" | "failed"; failed: number; reasons: string[] } {
  const reasons: string[] = [];
  if (input.failed > 0) reasons.push("partial_work_failed");
  if (input.ledgerUpdateFailed) reasons.push("cron_ledger_update_failed");
  const failed = input.failed + (input.ledgerUpdateFailed ? 1 : 0);
  if (input.ledgerUpdateFailed && input.failed === 0) {
    return { ok: false, httpStatus: 500, cronStatus: "failed", failed, reasons };
  }
  if (failed === 0) return { ok: true, httpStatus: 200, cronStatus: "succeeded", failed: 0, reasons };
  if (input.processed > 0) return { ok: false, httpStatus: 207, cronStatus: "partial", failed, reasons };
  return { ok: false, httpStatus: 500, cronStatus: "failed", failed, reasons };
}

/** Downstream channel failures are part of the cron result. HTTP 200 is not success. */
export function assessPublicationDownstream(input: {
  shopify: PublicationChannelResult;
  base: PublicationChannelResult;
  ledgerUpdateFailed?: boolean;
}): PublicationDownstreamReport {
  const shopifyCount = shopifyFailures(input.shopify);
  const baseCount = baseFailures(input.base);
  const reasons: string[] = [];
  if (input.shopify.configured === false) reasons.push("shopify_not_configured");
  else if (shopifyCount > 0) reasons.push("shopify_downstream_failed");
  if (baseCount > 0) reasons.push("base_downstream_failed");
  if (input.ledgerUpdateFailed) reasons.push("cron_ledger_update_failed");
  const failed = shopifyCount + baseCount + (input.ledgerUpdateFailed ? 1 : 0);
  const cronStatus = failed === 0 ? "succeeded" : "partial";
  return {
    ok: failed === 0,
    httpStatus: failed === 0 ? 200 : 207,
    cronStatus: input.ledgerUpdateFailed && shopifyCount === 0 && baseCount === 0 ? "failed" : cronStatus,
    failed,
    shopifyFailures: shopifyCount,
    baseFailures: baseCount,
    reasons,
  };
}

export type CatalogSyncOutcome = {
  matched: boolean;
  reason?: string;
};

/**
 * Keep a durable retry until canonical-link verification, listing activation
 * (performed by the matcher), and catalog synchronization have all succeeded.
 * The callbacks are injectable so failure ordering is covered without a live DB.
 */
export async function finalizeInternalSupplyLinkRetry(args: {
  syncCatalog: () => Promise<CatalogSyncOutcome>;
  persistFailure: (reason: string) => Promise<void>;
  clearRetry: () => Promise<void>;
}): Promise<CatalogSyncOutcome> {
  let outcome: CatalogSyncOutcome;
  try {
    outcome = await args.syncCatalog();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await args.persistFailure(reason || "catalog_sync_exception");
    throw error;
  }

  if (!outcome.matched) {
    await args.persistFailure(outcome.reason ?? "catalog_sync_not_matched");
    return outcome;
  }

  // This is intentionally last: any sync failure must leave a retry to re-run.
  await args.clearRetry();
  return outcome;
}

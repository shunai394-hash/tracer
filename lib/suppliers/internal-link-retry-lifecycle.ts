export type CatalogSyncOutcome = {
  matched: boolean;
  reason?: string;
};

/**
 * Finalize an internal supply link only after downstream catalog sync succeeds.
 * Failure callbacks must durably reschedule the candidate before this function
 * throws, and retry deletion must be the final operation.
 */
export async function finalizeInternalSupplyLinkRetry(args: {
  syncCatalog: () => Promise<CatalogSyncOutcome>;
  persistFailure: (reason: string) => Promise<void>;
  clearRetry: () => Promise<void>;
}): Promise<CatalogSyncOutcome> {
  let outcome: CatalogSyncOutcome | null = null;
  let failureReason: string | null = null;

  try {
    outcome = await args.syncCatalog();
    if (!outcome.matched) {
      failureReason = outcome.reason ?? "catalog_sync_not_matched";
    }
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
    outcome = { matched: false, reason: "sync_exception" };
  }

  if (!outcome?.matched) {
    await args.persistFailure(failureReason ?? "catalog_sync_not_confirmed");
    throw new Error(`catalog sync failed; retry retained: ${failureReason ?? "unknown"}`);
  }

  await args.clearRetry();
  return outcome;
}

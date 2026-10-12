export type PublicationRollbackPatch = {
  published: false;
  pipeline_stage: "BLOCKED";
  pipeline_status: "blocked";
  pipeline_reason: "shopify_publication_database_commit_failed";
  pipeline_updated_at: string;
  published_at: null;
  shopify_sync_status: "blocked" | "failed";
  shopify_sync_error: string;
  shopify_synced_at: string;
};

export type PublicationRollbackResult = {
  unpublished: boolean;
  statePersisted: boolean;
  error: string;
};

/**
 * Compensate a remote Shopify publication when persisting its local state fails.
 * Both operations are injectable so failure cases can be exercised without live
 * Shopify or production database credentials.
 */
export async function compensateShopifyPublication(args: {
  productId: string;
  originalError: string;
  unpublish: (productId: string) => Promise<void>;
  persist: (patch: PublicationRollbackPatch) => Promise<{ error?: { message: string } | null }>;
  now?: () => string;
}): Promise<PublicationRollbackResult> {
  let unpublishError: string | null = null;
  try {
    await args.unpublish(args.productId);
  } catch (error) {
    unpublishError = error instanceof Error ? error.message : String(error);
  }

  const stateError = unpublishError
    ? `publish_rollback_failed:${unpublishError}; original_error:${args.originalError}`
    : `publication_rolled_back_after_database_failure:${args.originalError}`;
  const timestamp = (args.now ?? (() => new Date().toISOString()))();
  let statePersisted = false;
  let stateWriteError: string | null = null;
  try {
    const result = await args.persist({
      published: false,
      pipeline_stage: "BLOCKED",
      pipeline_status: "blocked",
      pipeline_reason: "shopify_publication_database_commit_failed",
      pipeline_updated_at: timestamp,
      published_at: null,
      shopify_sync_status: unpublishError ? "failed" : "blocked",
      shopify_sync_error: stateError.slice(0, 2000),
      shopify_synced_at: timestamp,
    });
    stateWriteError = result.error?.message ?? null;
    statePersisted = !stateWriteError;
  } catch (error) {
    stateWriteError = error instanceof Error ? error.message : String(error);
  }

  const errors = [
    unpublishError ? `unpublish_failed:${unpublishError}` : null,
    stateWriteError ? `state_write_failed:${stateWriteError}` : null,
  ].filter(Boolean);
  return {
    unpublished: unpublishError === null,
    statePersisted,
    error: [stateError, ...errors].join("; ").slice(0, 2000),
  };
}

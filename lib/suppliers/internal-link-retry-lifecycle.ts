import { internalLinkRetryDelayMs } from "./cj-identity-reverify-policy.ts";

// Dependency-free (no server-only imports) so the real candidate lifecycle can
// be exercised directly by scripts/test-internal-link-retry-lifecycle.mjs.

export type CatalogSyncOutcome = {
  matched: boolean;
  reason?: string;
  catalogId?: string | null;
  variantId?: string | null;
};

export type FinalizeResult =
  /** Catalog sync committed, the persisted link was read back, retry removed. */
  | { status: "linked"; outcome: CatalogSyncOutcome }
  /** Sync rejected, threw, timed out or could not be verified; retry persisted. */
  | { status: "retry_retained"; kind: "rejected" | "exception" | "unverified"; retryable: true; reason: string; outcome: CatalogSyncOutcome }
  /** Link is verified but the retry row could not be deleted; it stays due and the next sweep re-runs idempotently. */
  | { status: "retry_cleanup_failed"; outcome: CatalogSyncOutcome; error: string };

export const DEFAULT_CATALOG_SYNC_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`catalog_sync_timeout_after_${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Finalize an internal supply link only after the catalog sync committed AND
 * the persisted canonical link was read back. Every failure durably
 * reschedules the candidate first; retry deletion is the final operation.
 * Throws only when the failure itself cannot be persisted (durability lost).
 */
export async function finalizeInternalSupplyLinkRetry(args: {
  syncCatalog: () => Promise<CatalogSyncOutcome>;
  /** Re-reads the committed link; false or a throw keeps the retry. */
  verifyPersisted?: (outcome: CatalogSyncOutcome) => Promise<boolean>;
  persistFailure: (failure: { kind: "rejected" | "exception" | "unverified"; reason: string }) => Promise<void>;
  clearRetry: () => Promise<void>;
  timeoutMs?: number;
}): Promise<FinalizeResult> {
  let outcome: CatalogSyncOutcome;
  let failure: { kind: "rejected" | "exception" | "unverified"; reason: string } | null = null;

  try {
    outcome = await withTimeout(args.syncCatalog(), args.timeoutMs ?? DEFAULT_CATALOG_SYNC_TIMEOUT_MS);
    if (!outcome.matched) failure = { kind: "rejected", reason: outcome.reason ?? "catalog_sync_not_matched" };
  } catch (error) {
    outcome = { matched: false, reason: "sync_exception" };
    failure = { kind: "exception", reason: message(error) };
  }

  if (!failure && args.verifyPersisted) {
    try {
      if (!(await args.verifyPersisted(outcome))) failure = { kind: "unverified", reason: "persisted_link_not_verified" };
    } catch (error) {
      failure = { kind: "unverified", reason: `persisted_link_verification_failed:${message(error)}` };
    }
  }

  if (failure) {
    await args.persistFailure(failure);
    return { status: "retry_retained", kind: failure.kind, retryable: true, reason: failure.reason, outcome };
  }

  try {
    await args.clearRetry();
  } catch (error) {
    return { status: "retry_cleanup_failed", outcome, error: message(error) };
  }
  return { status: "linked", outcome };
}

export type InternalLinkResult = {
  matched: boolean;
  supplierListingId: string | null;
  supplyVariantId: string | null;
  linkStatus?: string;
  reason: string;
};

export type RetryQueueRow = {
  bestseller_id: string;
  supplier_listing_id: string | null;
  supply_variant_id: string | null;
  reason: string;
  link_status: string | null;
  retry_count: number;
  last_attempt_at: string;
  next_attempt_at: string;
  last_error: string | null;
  updated_at: string;
};

export type RetryQueueStore = {
  /** Upsert on bestseller_id; must throw when the write fails. */
  upsert: (row: RetryQueueRow) => Promise<void>;
  /** Delete by bestseller_id; must throw when the delete fails. */
  remove: (bestsellerId: string) => Promise<void>;
};

export type CandidateOutcome =
  | { status: "linked"; candidateId: string; link: InternalLinkResult; catalog: CatalogSyncOutcome }
  | { status: "link_not_matched"; candidateId: string; link: InternalLinkResult; retryCount: number; nextAttemptAt: string }
  | { status: "catalog_sync_retry"; candidateId: string; link: InternalLinkResult; kind: "rejected" | "exception" | "unverified"; reason: string; retryCount: number; nextAttemptAt: string }
  | { status: "retry_cleanup_failed"; candidateId: string; link: InternalLinkResult; catalog: CatalogSyncOutcome; error: string }
  | { status: "candidate_error"; candidateId: string; error: string };

export type InternalLinkCandidateDeps = {
  loadBestseller: (candidateId: string) => Promise<Record<string, unknown> | null>;
  linkInternalSupply: (bestseller: Record<string, unknown>) => Promise<InternalLinkResult>;
  syncCatalog: (args: { bestsellerId: string; bestseller: Record<string, unknown>; supplyVariantId: string | null }) => Promise<CatalogSyncOutcome>;
  verifyPersistedLink: (args: { outcome: CatalogSyncOutcome; supplyVariantId: string | null }) => Promise<boolean>;
  retryQueue: RetryQueueStore;
  /** Attempts already recorded for this candidate (retry_count in the queue). */
  priorRetryCount: (candidateId: string) => number;
  now?: () => Date;
  syncTimeoutMs?: number;
};

function retrySchedule(deps: InternalLinkCandidateDeps, candidateId: string) {
  const now = (deps.now ?? (() => new Date()))();
  const retryCount = Math.max(0, Number(deps.priorRetryCount(candidateId)) || 0) + 1;
  return {
    retryCount,
    nowIso: now.toISOString(),
    nextAttemptAt: new Date(now.getTime() + internalLinkRetryDelayMs(retryCount)).toISOString(),
  };
}

/**
 * One candidate through the real lifecycle: canonical link, catalog sync,
 * read-back verification, then retry cleanup. Non-durable failures (retry
 * persistence) are rethrown; everything else becomes an outcome so one bad
 * candidate never aborts the batch.
 */
export async function processInternalLinkCandidate(candidateId: string, deps: InternalLinkCandidateDeps): Promise<CandidateOutcome | { status: "not_found"; candidateId: string }> {
  const bestseller = await deps.loadBestseller(candidateId);
  if (!bestseller) return { status: "not_found", candidateId };

  const link = await deps.linkInternalSupply(bestseller);
  if (!link.matched) {
    const schedule = retrySchedule(deps, candidateId);
    await deps.retryQueue.upsert({
      bestseller_id: candidateId,
      supplier_listing_id: link.supplierListingId,
      supply_variant_id: link.supplyVariantId,
      reason: link.reason,
      link_status: link.linkStatus ?? null,
      retry_count: schedule.retryCount,
      last_attempt_at: schedule.nowIso,
      next_attempt_at: schedule.nextAttemptAt,
      last_error: link.reason === "lookup_failed" || link.reason === "variant_lookup_failed"
        ? "Supplier identity lookup failed; see cron telemetry"
        : null,
      updated_at: schedule.nowIso,
    });
    return { status: "link_not_matched", candidateId, link, retryCount: schedule.retryCount, nextAttemptAt: schedule.nextAttemptAt };
  }

  let scheduled: ReturnType<typeof retrySchedule> | null = null;
  const result = await finalizeInternalSupplyLinkRetry({
    syncCatalog: () => deps.syncCatalog({ bestsellerId: candidateId, bestseller, supplyVariantId: link.supplyVariantId }),
    verifyPersisted: (outcome) => deps.verifyPersistedLink({ outcome, supplyVariantId: link.supplyVariantId }),
    persistFailure: async (failure) => {
      scheduled = retrySchedule(deps, candidateId);
      await deps.retryQueue.upsert({
        bestseller_id: candidateId,
        supplier_listing_id: link.supplierListingId,
        supply_variant_id: link.supplyVariantId,
        reason: "catalog_sync_failed",
        link_status: failure.kind === "rejected" ? "catalog_sync_rejected" : failure.kind === "exception" ? "catalog_sync_error" : "catalog_link_unverified",
        retry_count: scheduled.retryCount,
        last_attempt_at: scheduled.nowIso,
        next_attempt_at: scheduled.nextAttemptAt,
        last_error: failure.reason.slice(0, 1000),
        updated_at: scheduled.nowIso,
      });
    },
    clearRetry: () => deps.retryQueue.remove(candidateId),
    timeoutMs: deps.syncTimeoutMs,
  });

  if (result.status === "linked") return { status: "linked", candidateId, link, catalog: result.outcome };
  if (result.status === "retry_cleanup_failed") return { status: "retry_cleanup_failed", candidateId, link, catalog: result.outcome, error: result.error };
  const schedule = scheduled as ReturnType<typeof retrySchedule> | null;
  return {
    status: "catalog_sync_retry",
    candidateId,
    link,
    kind: result.kind,
    reason: result.reason,
    retryCount: schedule?.retryCount ?? 0,
    nextAttemptAt: schedule?.nextAttemptAt ?? "",
  };
}

/**
 * Process a batch sequentially. A candidate that throws (e.g. its failure
 * could not be persisted) is reported as candidate_error and the batch
 * continues; callers must treat any candidate_error as a failed run.
 */
export async function processInternalLinkCandidates(candidateIds: string[], deps: InternalLinkCandidateDeps) {
  const outcomes: Array<CandidateOutcome | { status: "not_found"; candidateId: string }> = [];
  for (const candidateId of candidateIds) {
    try {
      outcomes.push(await processInternalLinkCandidate(candidateId, deps));
    } catch (error) {
      outcomes.push({ status: "candidate_error", candidateId, error: message(error) });
    }
  }
  return outcomes;
}

/** Due when next_attempt_at is missing or not later than now (compared as instants, not strings). */
export function isInternalLinkRetryDue(nextAttemptAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!nextAttemptAt) return true;
  const due = Date.parse(nextAttemptAt);
  return Number.isFinite(due) && due <= nowMs;
}

// Minimal structural view of the Supabase client used by the adapters below,
// so tests can pass an in-memory table instead of a live database.
type QueryResult<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;
type LifecycleDb = {
  from: (table: string) => {
    upsert: (row: Record<string, unknown>, options: { onConflict: string }) => QueryResult<unknown>;
    delete: () => { eq: (column: string, value: string) => QueryResult<unknown> };
    select: (columns: string) => { eq: (column: string, value: string) => { maybeSingle: () => QueryResult<Record<string, unknown>> } };
  };
};

export function createRetryQueueStore(db: LifecycleDb): RetryQueueStore {
  return {
    upsert: async (row) => {
      const { error } = await db.from("internal_supply_link_retry_queue").upsert(row, { onConflict: "bestseller_id" });
      if (error) throw new Error(`internal link retry persistence failed for ${row.bestseller_id}: ${error.message}`);
    },
    remove: async (bestsellerId) => {
      const { error } = await db.from("internal_supply_link_retry_queue").delete().eq("bestseller_id", bestsellerId);
      if (error) throw new Error(`verified link and catalog sync succeeded but retry queue cleanup failed for ${bestsellerId}: ${error.message}`);
    },
  };
}

/** Read back the committed catalog variant and require it to point at the linked supply variant. */
export function createPersistedLinkVerifier(db: LifecycleDb): InternalLinkCandidateDeps["verifyPersistedLink"] {
  return async ({ outcome, supplyVariantId }) => {
    if (!outcome.catalogId || !outcome.variantId || !supplyVariantId) return false;
    const { data, error } = await db
      .from("tracer_supply_variants")
      .select("id,catalog_id,internal_supply_variant_id")
      .eq("id", String(outcome.variantId))
      .maybeSingle();
    if (error) throw new Error(error.message);
    return Boolean(data)
      && String(data?.catalog_id) === String(outcome.catalogId)
      && String(data?.internal_supply_variant_id) === String(supplyVariantId);
  };
}

/**
 * Shared current bestseller intake size.
 *
 * Supplier verification is still serialized per product because CJ
 * product/variant/stock/freight calls are rate-limited. We deliberately
 * increase the queue width so one slow candidate cannot starve the pipeline.
 * Only candidates that pass the existing identity, supply, intelligence,
 * profit and sales-test gates can become public.
 */
export const BESTSELLER_CANDIDATE_BATCH_SIZE = 50;

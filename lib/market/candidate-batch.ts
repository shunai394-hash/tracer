/**
 * Single shared "current batch" size for the bestseller pipeline.
 *
 * Supplier investigation is intentionally one row at a time because CJ
 * product/detail/JP-variant/stock/freight verification is serialized by the
 * supplier API rate limit. The goal of this batch is to get a real,
 * sales-eligible product through the full chain, not to create a large
 * unverified backlog.
 *
 * The later sales-test and BASE cron stages run automatically from vercel.json
 * after supplier investigation.
 */
export const BESTSELLER_CANDIDATE_BATCH_SIZE = 10;

/**
 * Single shared "current batch" size for the bestseller pipeline.
 *
 * investigate-dropship.ts (supplier investigation) and
 * select-sales-tests.ts (sales-candidate selection) must operate over the
 * exact same set of marketplace_bestsellers rows within one
 * /api/intelligence/bestsellers run, or supplier_listings rows the first
 * stage just wrote will never be found by the second.
 *
 * `rank` resets to 1..N on every scrape and carries no run/batch id, so it
 * cannot be used to scope a query to "the rows this run just touched" —
 * only `fetched_at` (set once per marketplace per collection run, see
 * lib/market/collect-bestsellers.ts) can. Both stages must order by
 * `fetched_at desc` and use this same limit.
 */
export const BESTSELLER_CANDIDATE_BATCH_SIZE = 30;

export type BestsellerGateStage = {
  ok: boolean;
  skipped?: boolean;
  retryable?: boolean;
};

/** Only completed, non-deferred stages may feed marketplace candidates downstream. */
export function canFeedSalesGate(stage: BestsellerGateStage): boolean {
  return stage.ok && stage.skipped !== true && stage.retryable !== true;
}

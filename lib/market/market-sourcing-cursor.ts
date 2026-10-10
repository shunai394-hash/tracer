export interface MarketSourcingCursorInput {
  evidenceWriteFailed: boolean;
  currentSourceIndex: number;
  nextSourceIndex: number;
  currentStartIndex: number;
  nextStartIndex: number;
}

export function getMarketSourcingCursor(input: MarketSourcingCursorInput): {
  sourceIndex: number;
  nextIndex: number;
} {
  // A failed evidence batch must be retried from the same source and page.
  if (input.evidenceWriteFailed) {
    return {
      sourceIndex: input.currentSourceIndex,
      nextIndex: input.currentStartIndex,
    };
  }
  return {
    sourceIndex: input.nextSourceIndex,
    nextIndex: input.nextStartIndex,
  };
}

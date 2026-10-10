export type MarketSourcingFailureKind = "none" | "write_failed" | "schema_missing" | "schema_probe_error";

export interface MarketSourcingCursorInput {
  failureKind: MarketSourcingFailureKind;
  currentSourceIndex: number;
  nextSourceIndex: number;
  currentStartIndex: number;
  nextStartIndex: number;
}

export function getMarketSourcingCursor(input: MarketSourcingCursorInput): {
  sourceIndex: number;
  nextIndex: number;
} {
  // A confirmed missing table cannot recover by retrying the same batch.
  // Advance to prevent a hot loop, but callers must mark replayRequired so
  // the skipped evidence gap is reconciled after the migration is applied.
  if (input.failureKind === "schema_missing") {
    return {
      sourceIndex: input.nextSourceIndex,
      nextIndex: input.nextStartIndex,
    };
  }

  // A transient probe error or write failure must retry the exact same batch.
  if (input.failureKind === "schema_probe_error" || input.failureKind === "write_failed") {
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

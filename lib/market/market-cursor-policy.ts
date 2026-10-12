export type MarketCursorPosition = { sourceIndex: number; startIndex: number };
export type MarketCursorObservation = {
  sourceIndex: number;
  nextIndex: number;
  hasMore: boolean;
};

/** The collector has eight configured sources; cursor values are normalized at the boundary. */
export const MARKET_SOURCE_COUNT = 8;

export function normalizeMarketCursor(sourceIndex: unknown, nextIndex: unknown): MarketCursorPosition {
  const source = Number(sourceIndex);
  const next = Number(nextIndex);
  return {
    sourceIndex: Number.isInteger(source) && source >= 0 ? source % MARKET_SOURCE_COUNT : 0,
    startIndex: Number.isInteger(next) && next >= 0 ? next : 0,
  };
}

/** Calculate the next position. This is pure policy; it does not persist or claim ownership. */
export function advanceMarketCursor(observation: MarketCursorObservation): MarketCursorPosition {
  if (observation.hasMore) {
    return {
      sourceIndex: normalizeMarketCursor(observation.sourceIndex, observation.nextIndex).sourceIndex,
      startIndex: normalizeMarketCursor(observation.sourceIndex, observation.nextIndex).startIndex,
    };
  }
  return {
    sourceIndex: (normalizeMarketCursor(observation.sourceIndex, 0).sourceIndex + 1) % MARKET_SOURCE_COUNT,
    startIndex: 0,
  };
}

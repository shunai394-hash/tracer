export type MarketCursorObservation = {
  sourceIndex: number;
  nextIndex: number;
  hasMore: boolean;
};

export type MarketCursor = { sourceIndex: number; startIndex: number };

export function nextMarketCursor(observation: MarketCursorObservation): MarketCursor;

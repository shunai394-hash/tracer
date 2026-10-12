const SOURCE_COUNT = 8;

/**
 * Pure transition for the market-sourcing cursor.
 * Continue the current source when more items remain; otherwise rotate once.
 */
export function nextMarketCursor(observation) {
  const sourceIndex = Number.isInteger(observation.sourceIndex) && observation.sourceIndex >= 0
    ? observation.sourceIndex % SOURCE_COUNT
    : 0;
  const nextIndex = Number.isInteger(observation.nextIndex) && observation.nextIndex >= 0
    ? observation.nextIndex
    : 0;
  return observation.hasMore
    ? { sourceIndex, startIndex: nextIndex }
    : { sourceIndex: (sourceIndex + 1) % SOURCE_COUNT, startIndex: 0 };
}

export function selectRotatingVariantBatch<T>(variants: T[], batchSize: number, runSlot: number): T[] {
  if (!Array.isArray(variants) || variants.length === 0 || !Number.isFinite(batchSize) || batchSize <= 0) return [];
  const size = Math.min(variants.length, Math.max(1, Math.floor(batchSize)));
  if (size === variants.length) return [...variants];
  const slot = Number.isFinite(runSlot) ? Math.max(0, Math.floor(runSlot)) : 0;
  const start = (slot * size) % variants.length;
  return Array.from({ length: size }, (_, offset) => variants[(start + offset) % variants.length]);
}

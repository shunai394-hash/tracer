export function uniqueRowsByKey<T>(
  rows: readonly T[],
  keyOf: (row: T) => string | null,
): { unique: Map<string, T>; ambiguousKeys: string[] } {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const unique = new Map<string, T>();
  const ambiguousKeys: string[] = [];
  for (const [key, list] of groups) {
    if (list.length === 1) unique.set(key, list[0]);
    else ambiguousKeys.push(key);
  }
  return { unique, ambiguousKeys };
}

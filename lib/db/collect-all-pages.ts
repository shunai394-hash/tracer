export type PageReadError = { message: string };

export async function collectAllPages<T>(
  fetchPage: (from: number, pageSize: number) => Promise<{ data: T[] | null; error: PageReadError | null }>,
  pageSize = 1000,
): Promise<{ data: T[]; error: PageReadError | null; offset: number | null }> {
  const data: T[] = [];
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    return { data, error: { message: "pageSize must be a positive integer" }, offset: 0 };
  }

  for (let from = 0; ; from += pageSize) {
    const result = await fetchPage(from, pageSize);
    if (result.error) return { data: [], error: result.error, offset: from };
    const rows = result.data ?? [];
    data.push(...rows);
    if (rows.length < pageSize) return { data, error: null, offset: null };
  }
}

type EvidenceRow = {
  supplier_listing_id?: string | null;
  source_currency?: unknown;
  fx_rate?: unknown;
  fx_observed_at?: unknown;
};

type SupplierEvidenceClient = {
  from: (table: string) => {
    select: (columns: string) => {
      in: (column: string, values: string[]) => PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }>;
    };
  };
};

function metadataNumber(metadata: unknown, key: string): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export async function attachSupplierCommercialEvidence<T extends EvidenceRow>(
  supabase: unknown,
  rows: T[],
): Promise<T[]> {
  const client = supabase as SupplierEvidenceClient;
  const ids = Array.from(new Set(rows
    .filter((row) => !(typeof row.source_currency === "string" && row.source_currency.trim()))
    .map((row) => typeof row.supplier_listing_id === "string" ? row.supplier_listing_id : "")
    .filter(Boolean)));
  const byId = new Map<string, Record<string, unknown>>();
  if (ids.length > 0) {
    const { data, error } = await client.from("supplier_listings").select("id,currency,metadata").in("id", ids);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) byId.set(String(row.id), row);
  }
  return rows.map((row) => {
    if (typeof row.source_currency === "string" && row.source_currency.trim()) return row;
    const supplier = typeof row.supplier_listing_id === "string" ? byId.get(row.supplier_listing_id) : undefined;
    return {
      ...row,
      source_currency: typeof supplier?.currency === "string" ? supplier.currency : null,
      fx_rate: row.fx_rate ?? metadataNumber(supplier?.metadata, "fx_rate"),
      fx_observed_at: row.fx_observed_at ?? metadataString(supplier?.metadata, "fx_observed_at"),
    };
  });
}

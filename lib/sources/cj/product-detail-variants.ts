export type CJProductDetailVariant = {
  vid: string;
  productId: string;
  sku: string | null;
  nameEn: string | null;
  variantImage: string | null;
  sellPrice: string | null;
};

/**
 * Normalize CJ's full product-detail response. The documented endpoint returns
 * data.stanProducts with id/img fields; some response variants use vid/variantImage.
 * Only retain variants whose parent product matches the requested canonical PID.
 */
export function normalizeCJProductDetailVariants(
  payload: unknown,
  expectedProductId: string,
): CJProductDetailVariant[] {
  const expectedPid = expectedProductId.trim();
  if (!expectedPid || !payload || typeof payload !== "object") return [];
  const envelope = payload as Record<string, unknown>;
  if (envelope.result === false) return [];
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;
  const rawRows = Array.isArray(record.stanProducts)
    ? record.stanProducts
    : Array.isArray(record.variants)
      ? record.variants
      : [];
  const seen = new Set<string>();
  const variants: CJProductDetailVariant[] = [];

  for (const raw of rawRows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const vid = String(row.id ?? row.vid ?? row.variantId ?? "").trim();
    const productId = String(row.pid ?? row.productId ?? expectedPid).trim();
    if (!vid || productId !== expectedPid || seen.has(vid)) continue;
    seen.add(vid);

    const rawImage = typeof row.img === "string"
      ? row.img
      : typeof row.variantImage === "string"
        ? row.variantImage
        : "";
    const variantImage = rawImage
      .split(",")
      .map((value) => value.trim())
      .find((value) => /^https?:\/\//i.test(value)) ?? null;

    variants.push({
      vid,
      productId,
      sku: String(row.sku ?? row.variantSku ?? "").trim() || null,
      nameEn: String(row.nameen ?? row.nameEn ?? row.variantNameEn ?? row.variantKey ?? "").trim() || null,
      variantImage,
      sellPrice: row.sellprice === undefined && row.variantSellPrice === undefined
        ? null
        : String(row.sellprice ?? row.variantSellPrice),
    });
  }
  return variants;
}

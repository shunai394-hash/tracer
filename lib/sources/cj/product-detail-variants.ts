
export type CJProductDetailSummary = {
  id: string;
  title: string;
  sku: string | null;
  price: string | null;
  imageUrl: string | null;
  inventory: number | null;
  listedNum: number | null;
  productType: string | null;
  saleStatus: string | null;
  barcode: string | null;
  shippingCost: string | null;
};

/** Normalize the documented productDetail/query response without accepting a sibling PID. */
export function normalizeCJProductDetailSummary(
  payload: unknown,
  expectedProductId: string,
): CJProductDetailSummary | null {
  const expectedPid = expectedProductId.trim();
  if (!expectedPid || !payload || typeof payload !== "object") return null;
  const envelope = payload as Record<string, unknown>;
  if (envelope.result === false) return null;
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const id = String(row.id ?? row.pid ?? expectedPid).trim();
  const title = String(row.nameen ?? row.nameEn ?? row.productNameEn ?? "").trim();
  if (id !== expectedPid || !title) return null;
  const imageValue = row.bigimg ?? row.bigImage ?? row.imageUrl;
  const imageUrl = typeof imageValue === "string" && /^https?:\/\//i.test(imageValue.trim())
    ? imageValue.trim()
    : null;
  const priceValue = row.sellprice ?? row.sellPrice ?? row.nowPrice;
  const inventoryValue = row.totalInventory ?? row.warehouseInventoryNum;
  const listedValue = row.listed ?? row.listedNum;
  const productType = String(row.producttype ?? row.productType ?? "").trim() || null;
  const saleStatus = String(row.saleStatus ?? row.salestatus ?? "").trim() || null;
  const barcode = String(row.barcode ?? row.productBarCode ?? "").trim() || null;
  const shippingCost = String(row.shippingCost ?? row.shippingcost ?? "").trim() || null;
  return {
    id,
    title,
    sku: String(row.sku ?? row.productSku ?? "").trim() || null,
    price: priceValue === undefined || priceValue === null ? null : String(priceValue),
    imageUrl,
    inventory: inventoryValue === undefined || inventoryValue === null || !Number.isFinite(Number(inventoryValue))
      ? null
      : Math.max(0, Math.floor(Number(inventoryValue))),
    listedNum: listedValue === undefined || listedValue === null || !Number.isFinite(Number(listedValue))
      ? null
      : Math.max(0, Math.floor(Number(listedValue))),
    productType,
    saleStatus,
    barcode,
    shippingCost,
  };
}

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

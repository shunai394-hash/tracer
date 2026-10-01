import "server-only";

import { getSuperDeliveryConfig } from "@/lib/config/env";

export type SuperDeliveryProductSet = {
  makerProductCode: string | null;
  sdProductCode: string | null;
  setNo: string | null;
  title: string | null;
  janCode: string | null;
  stock: number | null;
  exhibitState: number | null;
  price: number | null;
  imageUrl: string | null;
  raw: Record<string, unknown>;
};

export class SuperDeliveryConfigError extends Error {
  readonly code = "SUPERDELIVERY_NOT_CONFIGURED" as const;
}

export class SuperDeliveryRequestError extends Error {
  readonly code = "SUPERDELIVERY_REQUEST_FAILED" as const;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(root: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function numberValue(root: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = root[key];
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = record(payload);
  for (const key of ["items", "products", "productSets", "product_set", "data", "result"]) {
    if (Array.isArray(root[key])) return root[key];
    const nested = record(root[key]);
    for (const nestedKey of ["items", "products", "productSets", "data"]) {
      if (Array.isArray(nested[nestedKey])) return nested[nestedKey];
    }
  }
  return [];
}

function normalizeItem(value: unknown): SuperDeliveryProductSet {
  const raw = record(value);
  return {
    makerProductCode: stringValue(raw, "makerProductCode", "maker_product_code", "makerCode"),
    sdProductCode: stringValue(raw, "sdProductCode", "sd_product_code", "productCode"),
    setNo: stringValue(raw, "setNo", "set_no", "setNumber"),
    title: stringValue(raw, "productName", "name", "title", "product_name"),
    janCode: stringValue(raw, "janCode", "jan_code", "JAN", "jan"),
    stock: numberValue(raw, "stock", "stockCount", "quantity"),
    exhibitState: numberValue(raw, "exhibitState", "exhibit_state"),
    price: numberValue(raw, "price", "buyerPrice", "wholesalePrice", "wholesale_price"),
    imageUrl: stringValue(raw, "imageUrl", "image_url", "image", "primaryImageUrl"),
    raw,
  };
}

function config() {
  const value = getSuperDeliveryConfig();
  if (!value.apiAuthCode) throw new SuperDeliveryConfigError("SUPER DELIVERY API auth code is not configured");
  return value;
}

async function request(): Promise<unknown> {
  const { apiAuthCode, baseUrl, timeoutMs } = config();
  const params = new URLSearchParams({
    apiAuthCode,
    exhibitState: "2",
    field: "stock,exhibitState,janCode",
  });
  const response = await fetch(
    `${baseUrl}?${params.toString()}`,
    {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    throw new SuperDeliveryRequestError(`SUPER DELIVERY API HTTP ${response.status}`);
  }
  return response.json();
}

export async function getSuperDeliveryCatalog(): Promise<SuperDeliveryProductSet[]> {
  const payload = await request();
  return extractItems(payload).map(normalizeItem);
}

export async function searchSuperDeliveryProducts(query: string): Promise<SuperDeliveryProductSet[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const items = await getSuperDeliveryCatalog();
  return items
    .filter((item) => {
      const haystack = [
        item.title,
        item.makerProductCode,
        item.sdProductCode,
        item.janCode,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(normalized) && item.stock !== null && item.stock > 0;
    })
    .slice(0, 50);
}

export function findSuperDeliveryProductsByJan(
  catalog: SuperDeliveryProductSet[],
  jan: string,
): SuperDeliveryProductSet[] {
  const normalized = jan.trim();
  if (!normalized) return [];
  return catalog.filter((item) => String(item.janCode ?? "").trim() === normalized);
}

export async function getSuperDeliveryProduct(productCode: string): Promise<SuperDeliveryProductSet | null> {
  const code = productCode.trim();
  if (!code) return null;
  const catalog = await getSuperDeliveryCatalog();
  return catalog.find(
    (item) => item.sdProductCode === code || item.makerProductCode === code,
  ) ?? null;
}

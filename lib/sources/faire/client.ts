import "server-only";

import { getFaireConfig } from "@/lib/config/env";

export class FaireConfigError extends Error {
  readonly code = "FAIRE_NOT_CONFIGURED" as const;
  constructor(message = "Faire is not configured") {
    super(message);
    this.name = "FaireConfigError";
  }
}

export class FaireRequestError extends Error {
  readonly code = "FAIRE_REQUEST_FAILED" as const;
  constructor(message = "Faire request failed") {
    super(message);
    this.name = "FaireRequestError";
  }
}

type Money = { amount?: number | string | null; currency?: string | null };
type FaireVariant = {
  id?: string;
  sku?: string | null;
  name?: string | null;
  wholesale_price?: Money | null;
  inventory?: number | null;
  available_quantity?: number | null;
};
type FaireProduct = {
  id?: string;
  name?: string;
  title?: string;
  short_description?: string | null;
  description?: string | null;
  variants?: FaireVariant[];
  images?: Array<{ url?: string | null }>;
};
type ProductResponse = {
  products?: FaireProduct[];
  data?: FaireProduct[];
  next_cursor?: string | null;
  cursor?: string | null;
};

function config() {
  const value = getFaireConfig();
  if (!value.accessToken) throw new FaireConfigError();
  return value;
}

function moneyValue(money: Money | null | undefined): number | null {
  if (!money || money.amount === undefined || money.amount === null) return null;
  const n = Number(money.amount);
  return Number.isFinite(n) ? n / 100 : null;
}

async function request<T>(path: string): Promise<T> {
  const { accessToken, baseUrl } = config();
  const response = await fetch(`${baseUrl.replace(/\\/$/, "")}/${path.replace(/^\\//, "")}`, {
    headers: {
      Accept: "application/json",
      "X-FAIRE-ACCESS-TOKEN": accessToken,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new FaireRequestError(`Faire request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export function normalizeFaireProduct(product: FaireProduct) {
  const id = product.id?.trim();
  const title = (product.name ?? product.title)?.trim();
  if (!id || !title) return null;
  const variant = product.variants?.[0] ?? null;
  const inventory =
    typeof variant?.inventory === "number"
      ? variant.inventory
      : typeof variant?.available_quantity === "number"
        ? variant.available_quantity
        : null;
  const unitCost = moneyValue(variant?.wholesale_price);
  return {
    id,
    title,
    variantId: variant?.id?.trim() || null,
    sku: variant?.sku?.trim() || null,
    unitCost,
    currency: variant?.wholesale_price?.currency ?? "USD",
    inventory,
    imageUrl: product.images?.[0]?.url ?? null,
    orderable: inventory === null ? null : inventory > 0,
  };
}

export async function searchFaireProducts(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const params = new URLSearchParams({ limit: "50" });
  const payload = await request<ProductResponse>(`products?${params.toString()}`);
  const products = payload.products ?? payload.data ?? [];
  return products
    .filter((product) => {
      const haystack = [
        product.name,
        product.title,
        product.short_description,
        product.description,
        ...(product.variants ?? []).map((v) => v.sku ?? ""),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalized);
    })
    .map(normalizeFaireProduct)
    .filter((product): product is NonNullable<ReturnType<typeof normalizeFaireProduct>> => product !== null);
}

export async function getFaireProduct(productId: string) {
  const id = productId.trim();
  if (!id) return null;
  const payload = await request<FaireProduct>(`products/${encodeURIComponent(id)}`);
  return normalizeFaireProduct(payload);
}

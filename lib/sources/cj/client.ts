import "server-only";

import { getCJConfig } from "@/lib/config/env";

export class CJConfigError extends Error {
  readonly code = "CJ_NOT_CONFIGURED" as const;

  constructor(message = "CJdropshipping is not configured") {
    super(message);
    this.name = "CJConfigError";
  }
}

export class CJRequestError extends Error {
  readonly code = "CJ_REQUEST_FAILED" as const;

  constructor(message = "CJdropshipping request failed") {
    super(message);
    this.name = "CJRequestError";
  }
}

type CJAuthResponse = {
  code?: number;
  result?: boolean;
  message?: string;
  data?: {
    accessToken?: string;
    refreshToken?: string;
  };
};

type CJProduct = {
  id?: string;
  nameEn?: string;
  sku?: string;
  bigImage?: string;
  sellPrice?: string;
  nowPrice?: string | null;
  warehouseInventoryNum?: number;
  listedNum?: number;
  productType?: string;
  saleStatus?: string;
};

type CJProductResponse = {
  code?: number;
  result?: boolean;
  message?: string;
  data?: {
    pageSize?: number;
    pageNumber?: number;
    totalRecords?: number;
    totalPages?: number;
    content?: Array<{
      productList?: CJProduct[];
    }>;
  };
};

export type CJProductCandidate = {
  id: string;
  title: string;
  sku: string | null;
  price: string | null;
  imageUrl: string | null;
  inventory: number | null;
  listedNum: number | null;
  productType: string | null;
  saleStatus: string | null;
};

export type CJSearchResult = {
  query: string;
  totalRecords: number;
  totalPages: number;
  products: CJProductCandidate[];
};

let cachedToken: {
  accessToken: string;
  expiresAt: number;
} | null = null;

function getConfig() {
  const config = getCJConfig();

  if (!config.apiKey) {
    throw new CJConfigError();
  }

  return config;
}

async function getAccessToken(): Promise<string> {
  const { apiKey } = getConfig();

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const response = await fetch(
    "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiKey }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(
      `CJ authentication failed with HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as CJAuthResponse;

  const accessToken = payload.data?.accessToken;

  if (!accessToken) {
    throw new CJRequestError(
      payload.message || "CJ access token was not returned",
    );
  }

  cachedToken = {
    accessToken,
    expiresAt: Date.now() + 150_000,
  };

  return accessToken;
}

function normalizeProduct(product: CJProduct): CJProductCandidate | null {
  const id = product.id?.trim();
  const title = product.nameEn?.trim();

  if (!id || !title) {
    return null;
  }

  return {
    id,
    title,
    sku: product.sku?.trim() || null,
    price: product.sellPrice?.trim() || product.nowPrice?.trim() || null,
    imageUrl: product.bigImage?.trim() || null,
    inventory:
      typeof product.warehouseInventoryNum === "number"
        ? product.warehouseInventoryNum
        : null,
    listedNum:
      typeof product.listedNum === "number" ? product.listedNum : null,
    productType: product.productType?.trim() || null,
    saleStatus: product.saleStatus?.trim() || null,
  };
}

export async function searchCJProducts(
  query: string,
  options?: {
    page?: number;
    size?: number;
  },
): Promise<CJSearchResult> {
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    throw new CJRequestError("CJ product search query is empty");
  }

  const page = options?.page ?? 1;
  const size = options?.size ?? 20;

  const token = await getAccessToken();

  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
    keyWord: normalizedQuery,
  });

  const response = await fetch(
    `https://developers.cjdropshipping.com/api2.0/v1/product/listV2?${params.toString()}`,
    {
      method: "GET",
      headers: {
        "CJ-Access-Token": token,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(
      `CJ product search failed with HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as CJProductResponse;

  if (payload.result === false) {
    throw new CJRequestError(
      payload.message || "CJ product search failed",
    );
  }

  const content = payload.data?.content ?? [];

  const rawProducts = content.flatMap(
    (group) => group.productList ?? [],
  );

  const products = rawProducts
    .map(normalizeProduct)
    .filter((product): product is CJProductCandidate => product !== null);

  return {
    query: normalizedQuery,
    totalRecords: payload.data?.totalRecords ?? products.length,
    totalPages: payload.data?.totalPages ?? 1,
    products,
  };
}

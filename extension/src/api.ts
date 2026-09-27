export type CapturedProduct = {
  url: string;
  title: string;
  price: number | null;
  currency: string | null;
  imageUrl: string | null;
  asin: string | null;
  jan: string | null;
  gtin: string | null;
  ean: string | null;
  upc: string | null;
  mpn: string | null;
  brand: string | null;
};

export type ProductResponse = {
  ok: boolean;
  error?: string;
  identity?: {
    linked: boolean;
    salesEligible: boolean;
    method: string;
    confidence: number;
    rationale: string;
  };
  persisted?: {
    productId: string;
    observationId: string;
    offerId: string | null;
    ecPulse: boolean;
  };
  ecPulse?: {
    title: string;
    gtin: string | null;
    price: number | null;
    currency: string | null;
  } | null;
};

async function settings() {
  return chrome.storage.local.get({
    apiUrl: "http://localhost:3000",
    apiKey: "",
  }) as Promise<{ apiUrl: string; apiKey: string }>;
}

export async function sendProduct(product: CapturedProduct): Promise<ProductResponse> {
  const config = await settings();
  const response = await fetch(
    `${config.apiUrl.replace(/\/$/, "")}/api/extension/product`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { "X-TRACER-EXTENSION-KEY": config.apiKey } : {}),
      },
      body: JSON.stringify(product),
    },
  );

  const body = (await response.json()) as ProductResponse;
  if (!response.ok) {
    throw new Error(body.error || `TRACER returned HTTP ${response.status}`);
  }

  return body;
}

export async function saveSettings(apiUrl: string, apiKey: string) {
  await chrome.storage.local.set({
    apiUrl: apiUrl.trim().replace(/\/$/, ""),
    apiKey: apiKey.trim(),
  });
}

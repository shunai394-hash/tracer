import "server-only";

import { getECPulseConfig } from "@/lib/config/env";

export class ECPulseConfigError extends Error {
  readonly code = "EC_PULSE_NOT_CONFIGURED" as const;

  constructor(message = "EC-Pulse is not configured") {
    super(message);
    this.name = "ECPulseConfigError";
  }
}

export class ECPulseRequestError extends Error {
  readonly code = "EC_PULSE_REQUEST_FAILED" as const;

  constructor(message = "EC-Pulse request failed") {
    super(message);
    this.name = "ECPulseRequestError";
  }
}

export type ECPulseProduct = {
  product: {
    title: string;
    brand: string | null;
    model: string | null;
    sku: string | null;
    gtin: string | null;
  };
  pricing: {
    price: number | null;
    list_price: number | null;
    currency: string | null;
  };
  availability: {
    status: string | null;
  };
  rating: {
    score: number | null;
    count: number;
  };
  seller: {
    name: string | null;
  };
  source: {
    site: string;
    url: string;
    image: string | null;
  };
  captured_at: string;
};

export type ECPulseMonitorRequest = {
  url: string;
  interval_minutes: number;
  webhook_url: string;
};

export type ECPulseMonitorResponse = {
  monitor_id?: string;
  id?: string;
  monitor?: {
    id?: string;
    monitor_id?: string;
    url?: string;
    interval_minutes?: number;
    webhook_url?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type ECPulsePriceChangedEvent = {
  event: "price_changed";
  monitor_id: string;
  old_price: number;
  new_price: number;
  currency?: string | null;
  url: string;
  source?: string | null;
  captured_at: string;
};

function getConfig() {
  const config = getECPulseConfig();

  if (!config.apiUrl) {
    throw new ECPulseConfigError("EC_PULSE_API_URL is not configured");
  }

  if (!config.apiKey) {
    throw new ECPulseConfigError("EC_PULSE_API_KEY is not configured");
  }

  return config;
}

async function request<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const config = getConfig();

  let response: Response;

  try {
    response = await fetch(
      new URL(path, config.apiUrl.endsWith("/") ? config.apiUrl : `${config.apiUrl}/`).toString(),
      {
        ...init,
        headers: {
          Accept: "application/json",
          "X-API-Key": config.apiKey,
          ...(init.headers ?? {}),
        },
        cache: "no-store",
      },
    );
  } catch {
    throw new ECPulseRequestError("Could not connect to EC-Pulse");
  }

  const raw = await response.text();

  if (!response.ok) {
    throw new ECPulseRequestError(
      `EC-Pulse returned HTTP ${response.status}${raw ? `: ${raw.slice(0, 500)}` : ""}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ECPulseRequestError("EC-Pulse returned invalid JSON");
  }
}

function assertHttpUrl(value: string): string {
  const url = value.trim();

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    throw new ECPulseRequestError("A valid http(s) product URL is required");
  }

  return url;
}

export async function fetchECPulseProduct(
  url: string,
): Promise<ECPulseProduct> {
  const normalizedUrl = assertHttpUrl(url);

  return request<ECPulseProduct>("/v1/products", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: normalizedUrl }),
  });
}

export async function createECPulseMonitor(
  input: ECPulseMonitorRequest,
): Promise<ECPulseMonitorResponse> {
  const normalizedUrl = assertHttpUrl(input.url);
  const webhookUrl = assertHttpUrl(input.webhook_url);

  if (
    !Number.isInteger(input.interval_minutes) ||
    input.interval_minutes < 1
  ) {
    throw new ECPulseRequestError(
      "interval_minutes must be a positive integer",
    );
  }

  return request<ECPulseMonitorResponse>("/v1/monitors", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: normalizedUrl,
      interval_minutes: input.interval_minutes,
      webhook_url: webhookUrl,
    }),
  });
}

export async function listECPulseMonitors(): Promise<unknown> {
  return request<unknown>("/v1/monitors", {
    method: "GET",
  });
}

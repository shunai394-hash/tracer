import "server-only";

import { getBrightDataConfig } from "@/lib/config/env";

export class BrightDataConfigError extends Error {
  readonly code = "BRIGHTDATA_NOT_CONFIGURED" as const;

  constructor(message = "Bright Data is not configured") {
    super(message);
    this.name = "BrightDataConfigError";
  }
}

export function isBrightDataConfigured(): boolean {
  return Boolean(getBrightDataConfig().apiToken);
}

export function getBrightDataClient() {
  const config = getBrightDataConfig();
  if (!config.apiToken) {
    throw new BrightDataConfigError();
  }
  return {
    zone: config.zone || null,
    /**
     * World-data capture will go through Bright Data from the server only.
     * No marketplace requests are issued in this foundation.
     */
    isReady: true as const,
  };
}

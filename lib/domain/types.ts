/**
 * Domain primitives for TRACER.
 * Product identity is separate from time-stamped observations of the world.
 */

export type SourceType =
  | "marketplace"
  | "brand_site"
  | "search"
  | "mcp"
  | "manual"
  | "unknown";

export type Brand = {
  id: string;
  name: string;
  createdAt: string;
};

export type Product = {
  id: string;
  brandId: string | null;
  canonicalName: string;
  createdAt: string;
};

export type Source = {
  id: string;
  name: string;
  sourceType: SourceType;
  baseUrl: string | null;
  provider: "brightdata" | "mcp" | "manual" | "unknown";
};

export type Observation = {
  id: string;
  productId: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  sourceType: SourceType;
  observedAt: string;
  capturedAt: string;
  rawData: unknown;
  normalizedData: unknown;
  confidence: number | null;
};

export type PriceObservation = Observation & {
  currency: string;
  amount: number;
};

export type MarketSignalKind = "price" | "demand" | "supply" | "trend" | "other";

export type MarketSignal = {
  id: string;
  productId: string | null;
  kind: MarketSignalKind;
  summary: string;
  observedAt: string;
  observationId: string | null;
  confidence: number | null;
};

export type DiscoveryStatus = "candidate" | "review" | "accepted" | "rejected";

export type Discovery = {
  id: string;
  productId: string | null;
  title: string;
  rationale: string;
  status: DiscoveryStatus;
  createdAt: string;
  observationIds: string[];
};

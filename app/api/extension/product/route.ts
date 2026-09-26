import { NextResponse } from "next/server";

import {
  EMPTY_IDENTIFIERS,
  identifiersFromRecord,
  matchProductIdentity,
  normalizeIdentifier,
  type ProductIdentifiers,
} from "@/lib/market/identifiers";
import { getExtensionConfig } from "@/lib/config/env";
import { fetchECPulseProduct } from "@/lib/sources/ec-pulse";
import { persistECPulseProduct } from "@/lib/tracer/persist-ec-pulse";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type ExtensionProductInput = {
  url?: unknown;
  title?: unknown;
  price?: unknown;
  currency?: unknown;
  imageUrl?: unknown;
  asin?: unknown;
  jan?: unknown;
  gtin?: unknown;
  ean?: unknown;
  upc?: unknown;
  mpn?: unknown;
  brand?: unknown;
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return null;
}

function requireHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must be http(s)");
  }
  return url.toString();
}

function identityKey(ids: ProductIdentifiers, url: string): string {
  if (ids.jan) return `jan::${ids.jan}`;
  if (ids.gtin) return `gtin::${ids.gtin}`;
  if (ids.ean) return `ean::${ids.ean}`;
  if (ids.upc) return `upc::${ids.upc}`;
  if (ids.asin) return `asin::${ids.asin}`;
  if (ids.mpn) return `mpn::${ids.mpn}`;
  return `extension-url::${url}`;
}

async function findProductByIdentifiers(ids: ProductIdentifiers) {
  const supabase = createSupabaseAdminClient();

  for (const scheme of ["asin", "jan", "gtin", "ean", "upc", "mpn"] as const) {
    const value = ids[scheme];
    if (!value) continue;

    const result = await supabase
      .from("products")
      .select("id, canonical_name, asin, jan, gtin, ean, upc, mpn, brand_id")
      .eq(scheme, value)
      .maybeSingle();

    if (result.error) {
      throw new Error(`Failed to find product by ${scheme}: ${result.error.message}`);
    }

    if (result.data) return result.data;
  }

  return null;
}

async function persistExtensionObservation(args: {
  input: ExtensionProductInput;
  ids: ProductIdentifiers;
  title: string;
  url: string;
  price: number | null;
  currency: string | null;
  brand: string | null;
  imageUrl: string | null;
  identity: ReturnType<typeof matchProductIdentity>;
}) {
  const supabase = createSupabaseAdminClient();
  const existing = await findProductByIdentifiers(args.ids);
  const key = identityKey(args.ids, args.url);

  let productId: string;

  if (existing) {
    productId = existing.id;

    const updated = await supabase
      .from("products")
      .update({
        canonical_name: args.title,
        asin: args.ids.asin ?? existing.asin,
        jan: args.ids.jan ?? existing.jan,
        gtin: args.ids.gtin ?? existing.gtin,
        ean: args.ids.ean ?? existing.ean,
        upc: args.ids.upc ?? existing.upc,
        mpn: args.ids.mpn ?? existing.mpn,
        identity_key: existing.identity_key ?? key,
      })
      .eq("id", productId);

    if (updated.error) {
      throw new Error(`Failed to update extension product: ${updated.error.message}`);
    }
  } else {
    const created = await supabase
      .from("products")
      .insert({
        canonical_name: args.title,
        identity_key: key,
        asin: args.ids.asin,
        jan: args.ids.jan,
        gtin: args.ids.gtin,
        ean: args.ids.ean,
        upc: args.ids.upc,
        mpn: args.ids.mpn,
      })
      .select("id")
      .single();

    if (created.error) {
      throw new Error(`Failed to create extension product: ${created.error.message}`);
    }

    productId = created.data.id;
  }

  const source = await supabase
    .from("sources")
    .select("id")
    .eq("name", "TRACER Chrome Extension")
    .maybeSingle();

  if (source.error) {
    throw new Error(`Failed to find extension source: ${source.error.message}`);
  }

  let sourceId = source.data?.id ?? null;

  if (!sourceId) {
    const createdSource = await supabase
      .from("sources")
      .insert({
        name: "TRACER Chrome Extension",
        source_type: "extension",
        base_url: "chrome-extension://tracer",
        provider: "tracer-extension",
      })
      .select("id")
      .single();

    if (createdSource.error) {
      throw new Error(`Failed to create extension source: ${createdSource.error.message}`);
    }

    sourceId = createdSource.data.id;
  }

  const observation = await supabase
    .from("observations")
    .insert({
      product_id: productId,
      source_id: sourceId,
      source_url: args.url,
      source_type: "extension",
      observed_at: new Date().toISOString(),
      captured_at: new Date().toISOString(),
      raw_data: args.input,
      normalized_data: {
        title: args.title,
        brand: args.brand,
        price: args.price,
        currency: args.currency,
        imageUrl: args.imageUrl,
        identifiers: args.ids,
        identity: args.identity,
      },
      confidence: args.identity.confidence,
    })
    .select("id")
    .single();

  if (observation.error) {
    throw new Error(`Failed to create extension observation: ${observation.error.message}`);
  }

  for (const scheme of ["asin", "jan", "gtin", "ean", "upc", "mpn"] as const) {
    const value = args.ids[scheme];
    if (!value) continue;

    const existingIdentifier = await supabase
      .from("product_identifiers")
      .select("id, product_id")
      .eq("scheme", scheme)
      .eq("value", value)
      .maybeSingle();

    if (existingIdentifier.error) {
      throw new Error(
        `Failed to inspect ${scheme} identifier: ${existingIdentifier.error.message}`,
      );
    }

    if (!existingIdentifier.data) {
      const createdIdentifier = await supabase
        .from("product_identifiers")
        .insert({
          product_id: productId,
          scheme,
          value,
          source: "tracer-extension",
        });

      if (createdIdentifier.error) {
        throw new Error(
          `Failed to save ${scheme} identifier: ${createdIdentifier.error.message}`,
        );
      }
    }
  }

  if (args.price !== null && args.currency) {
    const priceResult = await supabase.from("price_observations").insert({
      id: observation.data.id,
      currency: args.currency,
      amount: args.price,
    });

    if (priceResult.error) {
      throw new Error(
        `Failed to save extension price observation: ${priceResult.error.message}`,
      );
    }
  }

  return {
    productId,
    observationId: observation.data.id,
    offerId: null,
  };
}

export async function POST(request: Request) {
  try {
    const config = getExtensionConfig();
    const expectedKey = config.apiKey;

    if (!expectedKey) {
      return NextResponse.json(
        { ok: false, error: "TRACER_EXTENSION_API_KEY is not configured" },
        { status: 503 },
      );
    }

    const suppliedKey = request.headers.get("X-TRACER-EXTENSION-KEY")?.trim();
    if (!suppliedKey || suppliedKey !== expectedKey) {
      return NextResponse.json(
        { ok: false, error: "Invalid extension key" },
        { status: 401 },
      );
    }

    const body = (await request.json()) as ExtensionProductInput;

    const rawUrl = stringValue(body.url);
    if (!rawUrl) {
      return NextResponse.json(
        { ok: false, error: "url is required" },
        { status: 400 },
      );
    }

    const url = requireHttpUrl(rawUrl);

    const title = stringValue(body.title);
    if (!title) {
      return NextResponse.json(
        { ok: false, error: "title is required" },
        { status: 400 },
      );
    }

    const incoming = identifiersFromRecord({
      asin: body.asin,
      jan: body.jan,
      gtin: body.gtin,
      ean: body.ean,
      upc: body.upc,
      mpn: body.mpn,
      url,
    });

    const existingProduct = await findProductByIdentifiers(incoming);

    const existingIds = existingProduct
      ? {
          asin: normalizeIdentifier("asin", existingProduct.asin),
          jan: normalizeIdentifier("jan", existingProduct.jan),
          gtin: normalizeIdentifier("gtin", existingProduct.gtin),
          ean: normalizeIdentifier("ean", existingProduct.ean),
          upc: normalizeIdentifier("upc", existingProduct.upc),
          mpn: normalizeIdentifier("mpn", existingProduct.mpn),
        }
      : EMPTY_IDENTIFIERS;

    const identity = existingProduct
      ? matchProductIdentity({
          market: { ...existingIds, title: existingProduct.canonical_name },
          supply: { ...incoming, title },
        })
      : {
          linked: false,
          salesEligible: false,
          method: "none" as const,
          confidence: 0,
          rationale: "new product capture; no existing TRACER identity found",
        };

    const persisted = await persistExtensionObservation({
      input: body,
      ids: incoming,
      title,
      url,
      price: numberValue(body.price),
      currency: stringValue(body.currency)?.toUpperCase() ?? null,
      brand: stringValue(body.brand),
      imageUrl: stringValue(body.imageUrl),
      identity,
    });

    let ecPulse: {
      title: string;
      gtin: string | null;
      price: number | null;
      currency: string | null;
    } | null = null;

    let ecPulsePersisted = false;
    let ecPulseError: string | null = null;

    try {
      const product = await fetchECPulseProduct(url);
      await persistECPulseProduct(product);

      ecPulse = {
        title: product.product.title,
        gtin: normalizeIdentifier("gtin", product.product.gtin),
        price: product.pricing.price,
        currency: product.pricing.currency,
      };
      ecPulsePersisted = true;
    } catch (error) {
      ecPulseError = error instanceof Error ? error.message : "EC-Pulse lookup failed";
      console.warn("[TRACER EXTENSION EC-PULSE]", ecPulseError);
    }

    return NextResponse.json({
      ok: true,
      captured: {
        title,
        url,
        identifiers: incoming,
      },
      identity,
      persisted: {
        ...persisted,
        ecPulse: ecPulsePersisted,
      },
      ecPulse,
      ecPulseError,
    });
  } catch (error) {
    console.error("[TRACER EXTENSION PRODUCT ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}


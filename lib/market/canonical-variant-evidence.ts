import { extractAsinFromUrl, normalizeIdentifier } from "./identifiers.ts";

export type CanonicalMarketplaceVariantEvidence = {
  sourceVariantId: string;
  sku: string | null;
  title: string | null;
  asin: string | null;
  jan: string | null;
  gtin: string | null;
  ean: string | null;
  upc: string | null;
  mpn: string | null;
  productUrl: string | null;
  evidenceSource: "schema_org_product_group_has_variant";
  rawEvidence: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function nodeList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function jsonLdNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const scriptPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    for (const rootValue of nodeList(parsed)) {
      const root = asRecord(rootValue);
      if (!root) continue;
      const graph = root["@graph"];
      if (Array.isArray(graph)) {
        for (const item of graph) {
          const record = asRecord(item);
          if (record) nodes.push(record);
        }
      } else {
        nodes.push(root);
      }
    }
  }
  return nodes;
}

function isType(record: Record<string, unknown>, expected: string): boolean {
  const type = record["@type"];
  return type === expected || (Array.isArray(type) && type.includes(expected));
}

function variantUrl(record: Record<string, unknown>, fallbackUrl: string | null): string | null {
  const direct = asString(record.url);
  if (direct) {
    try { return new URL(direct, fallbackUrl ?? "https://www.amazon.co.jp").toString(); } catch { /* ignore invalid URL */ }
  }
  const id = asString(record["@id"]);
  if (id) {
    try { return new URL(id, fallbackUrl ?? "https://www.amazon.co.jp").toString(); } catch { /* ignore invalid URL */ }
  }
  return null;
}

/**
 * Extract only explicit ProductGroup.hasVariant Product nodes. Parent Product
 * identifiers are deliberately not copied onto child variants: a parent GTIN
 * cannot prove the identity of a concrete size/color/pack variant.
 */
export function parseCanonicalMarketplaceVariantEvidence(
  html: string,
  parentProductUrl: string | null = null,
): CanonicalMarketplaceVariantEvidence[] {
  const output: CanonicalMarketplaceVariantEvidence[] = [];
  const seen = new Set<string>();

  for (const group of jsonLdNodes(html)) {
    if (!isType(group, "ProductGroup")) continue;
    for (const rawVariant of nodeList(group.hasVariant)) {
      const variant = asRecord(rawVariant);
      if (!variant || !isType(variant, "Product")) continue;

      const url = variantUrl(variant, parentProductUrl);
      const asin = extractAsinFromUrl(url);
      const parentAsin = extractAsinFromUrl(parentProductUrl);
      const sku = asString(variant.sku);
      const productId = asString(variant.productID);

      // A fallback to the parent page URL is useful for context, but its ASIN
      // is not a child-variant identifier. Prefer identifiers declared on the
      // child node; accept a URL-derived ASIN only when it differs from parent.
      const urlAsinIsVariantSpecific = Boolean(asin && asin !== parentAsin);
      const sourceVariantId = productId ?? sku ?? (urlAsinIsVariantSpecific ? asin : null);
      if (!sourceVariantId || seen.has(sourceVariantId)) continue;

      const gtinRaw =
        asString(variant.gtin14) ??
        asString(variant.gtin13) ??
        asString(variant.gtin12) ??
        asString(variant.gtin8) ??
        asString(variant.gtin);
      const janRaw = asString(variant.jan);
      const eanRaw = asString(variant.ean);
      const upcRaw = asString(variant.upc);
      const gtin = normalizeIdentifier("gtin", gtinRaw);
      const jan = normalizeIdentifier("jan", janRaw);
      const ean = normalizeIdentifier("ean", eanRaw);
      const upc = normalizeIdentifier("upc", upcRaw);

      seen.add(sourceVariantId);
      output.push({
        sourceVariantId,
        sku,
        title: asString(variant.name),
        asin,
        jan,
        gtin,
        ean,
        upc,
        mpn: normalizeIdentifier("mpn", asString(variant.mpn)),
        productUrl: url,
        evidenceSource: "schema_org_product_group_has_variant",
        rawEvidence: {
          source_variant_id: sourceVariantId,
          url,
          sku,
          name: asString(variant.name),
          productID: productId,
          gtinRaw,
          janRaw,
          eanRaw,
          upcRaw,
          mpn: asString(variant.mpn),
          parent_product_url: parentProductUrl,
        },
      });
    }
  }

  return output;
}

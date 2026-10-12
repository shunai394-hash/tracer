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
  evidenceSource: "schema_org_product_group_has_variant" | "amazon_variation_asin_map";
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

function collectDimensionStrings(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap(collectDimensionStrings);
  const record = asRecord(value);
  return record ? Object.values(record).flatMap(collectDimensionStrings) : [];
}

function extractBalancedJsonObject(source: string, start: number): { value: unknown; end: number } | null {
  if (source[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return { value: JSON.parse(source.slice(start, i + 1)), end: i + 1 }; }
        catch { return null; }
      }
    }
  }
  return null;
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
  const matches = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    const normalized = value.trim().replace(/[\\/#]$/, "").split(/[\\/#]/).pop();
    return normalized?.toLowerCase() === expected.toLowerCase();
  };
  return Array.isArray(type) ? type.some(matches) : matches(type);
}

export type CanonicalVariantMarkupDiagnostics = {
  jsonLdNodeCount: number;
  productGroupCount: number;
  groupsWithVariantCount: number;
  variantProductNodeCount: number;
  absoluteTypeIriCount: number;
};

/** Aggregate-only diagnostics; never returns source HTML or product/customer payloads. */
export function inspectCanonicalMarketplaceVariantMarkup(html: string): CanonicalVariantMarkupDiagnostics {
  const nodes = jsonLdNodes(html);
  const groups = nodes.filter((node) => isType(node, "ProductGroup"));
  let groupsWithVariantCount = 0;
  let variantProductNodeCount = 0;
  for (const group of groups) {
    const variants = nodeList(group.hasVariant);
    if (variants.length > 0) groupsWithVariantCount += 1;
    variantProductNodeCount += variants.filter((value) => {
      const record = asRecord(value);
      return Boolean(record && isType(record, "Product"));
    }).length;
  }
  const typedRecords = [
    ...nodes,
    ...groups.flatMap((group) => nodeList(group.hasVariant).map(asRecord).filter(
      (record): record is Record<string, unknown> => record !== null,
    )),
  ];
  const absoluteTypeIriCount = typedRecords.reduce((count, node) => {
    const types = nodeList(node["@type"]);
    return count + types.filter((value) => typeof value === "string" && /^https?:\/\/schema\.org\//i.test(value.trim())).length;
  }, 0);
  return {
    jsonLdNodeCount: nodes.length,
    productGroupCount: groups.length,
    groupsWithVariantCount,
    variantProductNodeCount,
    absoluteTypeIriCount,
  };
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
  const nodes = jsonLdNodes(html);
  const nodesById = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const id = asString(node["@id"]);
    if (id) nodesById.set(id, node);
  }

  for (const group of nodes) {
    if (!isType(group, "ProductGroup")) continue;
    for (const rawVariant of nodeList(group.hasVariant)) {
      const reference = asRecord(rawVariant);
      // JSON-LD often stores hasVariant as an @id reference while the full
      // Product node appears elsewhere in the same @graph. Resolve only local
      // references; an unresolved @id must never be used as identity evidence.
      const variant = reference && isType(reference, "Product")
        ? reference
        : reference && asString(reference["@id"])
          ? nodesById.get(asString(reference["@id"]) as string) ?? null
          : null;
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
      const sourceVariantId = (urlAsinIsVariantSpecific ? asin : null) ?? productId ?? sku;
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
        // Never expose the parent page ASIN as a child variant identifier,
        // even when the child node explicitly repeats the parent URL.
        asin: urlAsinIsVariantSpecific ? asin : null,
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


export type AmazonVariationAsinEvidence = {
  asin: string;
  variationValues: string[];
};

/**
 * Extract Amazon's explicit child-ASIN-to-dimension map from embedded page data.
 * The parent/child relationship is only discovery evidence; a child must still
 * expose its own valid barcode on its own detail page before supplier linking.
 */
export function parseAmazonVariationAsinMap(
  html: string,
  parentProductUrl: string | null = null,
): AmazonVariationAsinEvidence[] {
  const parentAsin = extractAsinFromUrl(parentProductUrl);
  const output: AmazonVariationAsinEvidence[] = [];
  const seen = new Set<string>();
  const patterns = [
    /(?:var|let|const)\\s+dimensionValuesDisplayData\\s*=/gi,
    /dimensionValuesDisplayData\\s*:/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      let start = pattern.lastIndex;
      while (start < html.length && /\\s/.test(html[start])) start += 1;
      const extracted = extractBalancedJsonObject(html, start);
      if (!extracted) continue;
      pattern.lastIndex = extracted.end;
      const record = asRecord(extracted.value);
      if (!record) continue;
      for (const [rawAsin, rawValues] of Object.entries(record)) {
        const asin = normalizeIdentifier("asin", rawAsin);
        if (!asin || asin === parentAsin || seen.has(asin)) continue;
        const variationValues = collectDimensionStrings(rawValues);
        seen.add(asin);
        output.push({ asin, variationValues });
      }
    }
  }
  return output;
}

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
  evidenceSource: "schema_org_product_group_has_variant" | "schema_org_product_is_variant_of" | "amazon_variation_asin_map";
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
  // Some Amazon templates serialize a variation map as a JSON string instead
  // of an object literal. Parse the quoted value, then decode its JSON payload.
  if (source[start] === '"') {
    let escaped = false;
    for (let i = start + 1; i < source.length; i += 1) {
      const char = source[i];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        try { return { value: JSON.parse(source.slice(start, i + 1)), end: i + 1 }; }
        catch { return null; }
      }
    }
    return null;
  }
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
  productModelCount: number;
  groupsWithVariantCount: number;
  variantProductNodeCount: number;
  isVariantOfProductCount: number;
  inProductGroupWithIdCount: number;
  childProductsWithExplicitParentRelation: number;
  absoluteTypeIriCount: number;
  jsonLdScriptTagCount: number;
  jsonLdParseFailureCount: number;
  variationMapMarkerCount: number;
  dimensionToAsinMapMarkerCount: number;
  twisterDataMarkerCount: number;
};

/** Aggregate-only diagnostics; never returns source HTML or product/customer payloads. */
export function inspectCanonicalMarketplaceVariantMarkup(html: string): CanonicalVariantMarkupDiagnostics {
  const nodes = jsonLdNodes(html);
  const jsonLdScriptMatches = [...html.matchAll(/<script\b[^>]*type\s*=\s*["'][^"']*ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const jsonLdParseFailureCount = jsonLdScriptMatches.filter((match) => {
    const raw = match[1].trim().replace(/^<!--/, "").replace(/-->$/, "").trim();
    try { JSON.parse(raw); return false; } catch { return true; }
  }).length;
  const variationMapNames = [
    "dimensionToAsinMap",
    "dimensionValuesDisplayData",
    "asinVariationValues",
    "variationValues",
    "variationDisplayValues",
    "variationDisplayData",
    "asinToVariationValues",
  ];
  const variationMapMarkerCount = variationMapNames.reduce((count, name) => {
    const matches = html.match(new RegExp(name, "gi"));
    return count + (matches?.length ?? 0);
  }, 0);
  const dimensionToAsinMapMarkerCount = (html.match(/dimensionToAsinMap/gi) ?? []).length;
  const twisterDataMarkerCount = (html.match(/twister-js-init-dpx-data|twisterJsInitData/gi) ?? []).length;
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
  const products = nodes.filter((node) => isType(node, "Product"));
  const productModelCount = nodes.filter((node) => isType(node, "ProductModel")).length;
  const isVariantOfProductCount = products.filter((node) => nodeList(node.isVariantOf).length > 0).length;
  const inProductGroupWithIdCount = products.filter((node) => Boolean(asString(node.inProductGroupWithID))).length;
  const childProductsWithExplicitParentRelation = products.filter((node) =>
    nodeList(node.isVariantOf).length > 0 || Boolean(asString(node.inProductGroupWithID)),
  ).length;
  return {
    jsonLdNodeCount: nodes.length,
    productGroupCount: groups.length,
    productModelCount,
    groupsWithVariantCount,
    variantProductNodeCount,
    isVariantOfProductCount,
    inProductGroupWithIdCount,
    childProductsWithExplicitParentRelation,
    absoluteTypeIriCount,
    jsonLdScriptTagCount: jsonLdScriptMatches.length,
    jsonLdParseFailureCount,
    variationMapMarkerCount,
    dimensionToAsinMapMarkerCount,
    twisterDataMarkerCount,
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

  // Schema.org also permits the inverse relationship: a child Product may
  // declare isVariantOf: ProductGroup while the parent has no hasVariant list.
  // The database already allows this evidence source, but the old collector
  // only traversed ProductGroup.hasVariant, silently dropping these children.
  for (const variant of nodes) {
    if (!isType(variant, "Product")) continue;
    const relations = nodeList(variant.isVariantOf).map(asRecord)
      .filter((relation): relation is Record<string, unknown> => relation !== null);
    // Some catalogs expose the group relation as Product.inProductGroupWithID
    // without embedding a ProductGroup node in the same JSON-LD graph.
    const inProductGroupWithID = asString(variant.inProductGroupWithID);
    const belongsToCanonicalVariantParent = Boolean(inProductGroupWithID) || relations.some((relation) => {
      // Schema.org permits isVariantOf to target either ProductGroup or
      // ProductModel. Both are explicit child-to-parent relations; resolve
      // local @id references rather than dropping children with a linked node.
      if (isType(relation, "ProductGroup") || isType(relation, "ProductModel")) return true;
      const relationId = asString(relation["@id"]);
      const referencedNode = relationId ? nodesById.get(relationId) : null;
      return Boolean(
        referencedNode
        && (isType(referencedNode, "ProductGroup") || isType(referencedNode, "ProductModel")),
      );
    });
    if (!belongsToCanonicalVariantParent) continue;

    const url = variantUrl(variant, parentProductUrl);
    const asin = extractAsinFromUrl(url);
    const parentAsin = extractAsinFromUrl(parentProductUrl);
    const urlAsinIsVariantSpecific = Boolean(asin && asin !== parentAsin);
    const sku = asString(variant.sku);
    const productId = asString(variant.productID);
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
      asin: urlAsinIsVariantSpecific ? asin : null,
      jan,
      gtin,
      ean,
      upc,
      mpn: normalizeIdentifier("mpn", asString(variant.mpn)),
      productUrl: url,
      evidenceSource: "schema_org_product_is_variant_of",
      rawEvidence: {
        source_variant_id: sourceVariantId,
        inProductGroupWithID,
        relation: inProductGroupWithID ? "Product.inProductGroupWithID" : "Product.isVariantOf",
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
  // Amazon changes the variable name between page templates/locales.
  // These are explicit ASIN-keyed variation maps only; any discovered ASIN
  // remains discovery evidence until its own detail page supplies a barcode.
  const mapNames = [
    "dimensionToAsinMap",
    "dimensionValuesDisplayData",
    "asinVariationValues",
    "variationValues",
    "variationDisplayValues",
    "variationDisplayData",
    "asinToVariationValues",
  ];
  const patterns = mapNames.flatMap((name) => [
    { name, pattern: new RegExp(`(?:var|let|const)\\s+${name}\\s*=`, "gi") },
    { name, pattern: new RegExp(`${name}[\"']?\\s*:`, "gi") },
  ]);
  // dimensionToAsinMap uses opaque tuple keys such as "10_7". Resolve those
  // tuples to customer-facing size/color labels when Amazon also exposes the
  // ASIN-keyed dimensionValuesDisplayData map in the same page payload.
  const variationValuesByAsin = new Map<string, string[]>();
  const displayPatterns = [
    new RegExp(`(?:var|let|const)\\s+dimensionValuesDisplayData\\s*=`, "gi"),
    new RegExp(`dimensionValuesDisplayData["']?\\s*:`, "gi"),
  ];
  for (const displayPattern of displayPatterns) {
    let displayMatch: RegExpExecArray | null;
    while ((displayMatch = displayPattern.exec(html))) {
      let start = displayPattern.lastIndex;
      while (start < html.length && /\s/.test(html[start])) start += 1;
      const extracted = extractBalancedJsonObject(html, start);
      if (!extracted) continue;
      displayPattern.lastIndex = extracted.end;
      let decodedValue: unknown = extracted.value;
      for (let decodeAttempt = 0; decodeAttempt < 2 && typeof decodedValue === "string"; decodeAttempt += 1) {
        try { decodedValue = JSON.parse(decodedValue) as unknown; } catch { break; }
      }
      const displayRecord = asRecord(decodedValue);
      if (!displayRecord) continue;
      for (const [rawKey, rawValues] of Object.entries(displayRecord)) {
        const asin = normalizeIdentifier("asin", rawKey);
        if (!asin || asin === parentAsin) continue;
        const values = collectDimensionStrings(rawValues)
          .filter((value) => !normalizeIdentifier("asin", value));
        if (values.length) variationValuesByAsin.set(asin, values);
      }
    }
  }

  for (const { name, pattern } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      let start = pattern.lastIndex;
      while (start < html.length && /\s/.test(html[start])) start += 1;
      const extracted = extractBalancedJsonObject(html, start);
      if (!extracted) continue;
      pattern.lastIndex = extracted.end;
      let decodedValue: unknown = extracted.value;
      // Double-encoded variation maps occur on some localized Amazon templates.
      // Decode at most twice and accept only explicit JSON maps.
      for (let decodeAttempt = 0; decodeAttempt < 2 && typeof decodedValue === "string"; decodeAttempt += 1) {
        try { decodedValue = JSON.parse(decodedValue) as unknown; } catch { break; }
      }
      const record = asRecord(decodedValue);
      if (!record) continue;
      for (const [rawKey, rawValues] of Object.entries(record)) {
        if (name === "dimensionToAsinMap") {
          // Amazon commonly maps a dimension tuple to a child ASIN instead of
          // mapping an ASIN to its dimensions. Treat only explicit map values
          // as child identities; never infer an ASIN from arbitrary page text.
          const mappedValues = collectDimensionStrings(rawValues);
          for (const mappedValue of mappedValues) {
            const asin = normalizeIdentifier("asin", mappedValue);
            if (!asin || asin === parentAsin || seen.has(asin)) continue;
            const displayValues = variationValuesByAsin.get(asin) ?? [];
            const variationValues = displayValues.length
              ? displayValues
              : [
                  rawKey,
                  ...mappedValues.filter((value) => !normalizeIdentifier("asin", value)),
                ].filter(Boolean);
            seen.add(asin);
            output.push({ asin, variationValues });
          }
          continue;
        }

        const asin = normalizeIdentifier("asin", rawKey);
        if (!asin || asin === parentAsin || seen.has(asin)) continue;
        const variationValues = collectDimensionStrings(rawValues);
        seen.add(asin);
        output.push({ asin, variationValues });
      }
    }
  }
  return output;
}

import assert from "node:assert/strict";
import { parseCanonicalMarketplaceVariantEvidence } from "../lib/market/canonical-variant-evidence.ts";

const html = `<script type="application/ld+json">[
 {"@type":"https://schema.org/ProductGroup","@id":"#g"},
 {"@type":"https://schema.org/Product","isVariantOf":{"@id":"#g"},"sku":"SKU-RED","gtin13":"4006381333931","url":"https://www.amazon.co.jp/dp/B0CHILD001"},
 {"@type":"https://schema.org/Product","isVariantOf":[{"@id":"#missing"},{"@id":"#g"}],"sku":"SKU-BLUE","url":"https://www.amazon.co.jp/dp/B0CHILD002"}
]</script>`;
const found = parseCanonicalMarketplaceVariantEvidence(html, "https://www.amazon.co.jp/dp/B0PARENT00");
assert.equal(found.length, 2);
assert.equal(found[0].sourceVariantId, "B0CHILD001");
assert.equal(found[0].evidenceSource, "schema_org_product_is_variant_of");
assert.equal(found[0].gtin, "4006381333931");
assert.equal(found[1].sourceVariantId, "B0CHILD002");
assert.equal(found[1].asin, "B0CHILD002");

// Do not accept a relation whose ProductGroup is absent from this JSON-LD document.
const orphan = `<script type="application/ld+json">{"@type":"Product","sku":"ORPHAN","isVariantOf":{"@id":"#missing"}}</script>`;
assert.equal(parseCanonicalMarketplaceVariantEvidence(orphan).length, 0);

// Do not copy a parent-page ASIN into a child record that has no variant-specific ID.
const parentOnly = `<script type="application/ld+json">[
 {"@type":"ProductGroup","@id":"#g"},
 {"@type":"Product","isVariantOf":{"@id":"#g"},"sku":"CHILD-SKU"}
]</script>`;
const parentOnlyFound = parseCanonicalMarketplaceVariantEvidence(parentOnly, "https://www.amazon.co.jp/dp/B0PARENT00");
assert.equal(parentOnlyFound.length, 1);
assert.equal(parentOnlyFound[0].asin, null);
assert.equal(parentOnlyFound[0].sourceVariantId, "CHILD-SKU");
console.log("PASS: isVariantOf evidence, array relationships, orphan rejection, and parent-ASIN isolation");

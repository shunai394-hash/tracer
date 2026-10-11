import assert from "node:assert/strict";
import { parseCanonicalMarketplaceVariantEvidence } from "../lib/market/canonical-variant-evidence.ts";

const isVariantOfHtml = `
<script type="application/ld+json">
[
  {"@type":"https://schema.org/ProductGroup","@id":"#group-1","name":"Example family"},
  {"@type":"https://schema.org/Product","@id":"#child-1","isVariantOf":{"@id":"#group-1"},"sku":"SKU-RED-M","name":"Example red medium","gtin13":"4006381333931","url":"https://www.amazon.co.jp/dp/B0CHILD001"},
  {"@type":"https://schema.org/Product","@id":"#child-2","isVariantOf":{"@id":"#group-1"},"sku":"SKU-BLUE-L","name":"Example blue large","url":"https://www.amazon.co.jp/dp/B0CHILD002"}
]
</script>`;
const variants = parseCanonicalMarketplaceVariantEvidence(isVariantOfHtml, "https://www.amazon.co.jp/dp/B0PARENT00");
assert.equal(variants.length, 2, "separate Product.isVariantOf children should be recovered");
assert.equal(variants[0].sourceVariantId, "B0CHILD001");
assert.equal(variants[0].evidenceSource, "schema_org_product_is_variant_of");
assert.equal(variants[0].gtin, "4006381333931");
assert.equal(variants[1].sourceVariantId, "B0CHILD002");
assert.equal(variants[1].asin, "B0CHILD002");

const hasVariantHtml = `
<script type="application/ld+json">
{"@type":"ProductGroup","@id":"#parent","hasVariant":[
  {"@type":"Product","sku":"CHILD-SKU","name":"Child without barcode"}
]}
</script>`;
const hasVariant = parseCanonicalMarketplaceVariantEvidence(hasVariantHtml, "https://www.amazon.co.jp/dp/B0PARENT00");
assert.equal(hasVariant.length, 1);
assert.equal(hasVariant[0].sourceVariantId, "CHILD-SKU");
assert.equal(hasVariant[0].asin, null, "parent ASIN must never be copied to child");

const unresolvedRelationHtml = `
<script type="application/ld+json">
{"@type":"Product","sku":"ORPHAN","isVariantOf":{"@id":"#missing-group"}}
</script>`;
assert.equal(parseCanonicalMarketplaceVariantEvidence(unresolvedRelationHtml).length, 0,
  "unresolved parent relationship must not create identity evidence");

console.log("PASS: Schema.org hasVariant + isVariantOf child evidence, parent-id isolation, unresolved-parent rejection");

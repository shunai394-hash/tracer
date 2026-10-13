import assert from "node:assert/strict";
import {
  parseAmazonVariationAsinMap,
  parseCanonicalMarketplaceVariantEvidence,
} from "../lib/market/canonical-variant-evidence.ts";

const parentUrl = "https://www.amazon.co.jp/dp/B0PARENT01";
const schemaHtml = `
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "ProductGroup",
      "hasVariant": [
        { "@id": "https://www.amazon.co.jp/dp/B0CHILD001" },
        { "@id": "#child-two" },
        { "@id": "#missing-child" }
      ]
    },
    {
      "@type": "Product",
      "@id": "https://www.amazon.co.jp/dp/B0CHILD001",
      "name": "ブラック",
      "sku": "SKU-BLACK",
      "gtin13": "4901234567894",
      "url": "https://www.amazon.co.jp/dp/B0CHILD001"
    },
    {
      "@type": "https://schema.org/Product",
      "@id": "#child-two",
      "name": "ブルー",
      "sku": "SKU-BLUE",
      "jan": "4901234567894"
    }
  ]
}
</script>`;

const schemaVariants = parseCanonicalMarketplaceVariantEvidence(schemaHtml, parentUrl);
assert.equal(schemaVariants.length, 2, "resolve explicit child Product nodes and ignore unresolved references");
assert.equal(schemaVariants[0].asin, "B0CHILD001", "use the child ASIN, not the parent ASIN");
assert.equal(schemaVariants[0].gtin, "4901234567894");
assert.equal(schemaVariants[1].asin, null, "do not invent an ASIN for a child with no child-specific URL");
assert.equal(schemaVariants[1].sku, "SKU-BLUE");
assert.equal(schemaVariants.some((variant) => variant.asin === "B0PARENT01"), false, "never copy parent ASIN to child");

const variationHtml = `
<script>
var dimensionValuesDisplayData = {"B0CHILD001":["ブラック","M"],"B0CHILD002":["ブルー","L"]};
</script>`;
const variationMap = parseAmazonVariationAsinMap(variationHtml, parentUrl);
assert.deepEqual(variationMap, [
  { asin: "B0CHILD001", variationValues: ["ブラック", "M"] },
  { asin: "B0CHILD002", variationValues: ["ブルー", "L"] },
], "parse explicit child ASIN dimension map");

const parentOnlyHtml = `
<script>
var dimensionValuesDisplayData = {"B0PARENT01":["親商品"],"not-an-asin":["bad"]};
</script>`;
assert.deepEqual(
  parseAmazonVariationAsinMap(parentOnlyHtml, parentUrl),
  [],
  "exclude parent ASIN and invalid child identifiers",
);


const nestedVariationHtml = `
<script>
var dimensionValuesDisplayData = {"B0CHILD003":["レッド",{"size":{"label":"XL"}}],"B0CHILD004":["グリーン","S"]};
</script>`;
assert.deepEqual(
  parseAmazonVariationAsinMap(nestedVariationHtml, parentUrl),
  [
    { asin: "B0CHILD003", variationValues: ["レッド", "XL"] },
    { asin: "B0CHILD004", variationValues: ["グリーン", "S"] },
  ],
  "parse complete nested dimension map rather than truncating at the first closing brace",
);

console.log("Amazon variant parser fixtures: passed");

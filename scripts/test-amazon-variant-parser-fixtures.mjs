import assert from "node:assert/strict";
import {
  inspectCanonicalMarketplaceVariantMarkup,
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

const inverseRelationHtml = `
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "ProductGroup", "@id": "https://www.amazon.co.jp/dp/B0PARENT01#group", "name": "親商品" },
    {
      "@type": "Product",
      "@id": "https://www.amazon.co.jp/dp/B0CHILD003",
      "isVariantOf": { "@id": "https://www.amazon.co.jp/dp/B0PARENT01#group" },
      "name": "子商品 赤 M",
      "sku": "CHILD-RED-M",
      "gtin13": "4901234567894",
      "url": "https://www.amazon.co.jp/dp/B0CHILD003"
    }
  ]
}
</script>`;
const inverseVariants = parseCanonicalMarketplaceVariantEvidence(inverseRelationHtml, parentUrl);
assert.equal(inverseVariants.length, 1, "collect child Product nodes that declare isVariantOf even when ProductGroup.hasVariant is absent");
assert.equal(inverseVariants[0].sourceVariantId, "B0CHILD003");
assert.equal(inverseVariants[0].asin, "B0CHILD003");
assert.equal(inverseVariants[0].gtin, "4901234567894");
assert.equal(inverseVariants[0].evidenceSource, "schema_org_product_is_variant_of");
assert.equal(inverseVariants[0].rawEvidence.relation, "Product.isVariantOf");

const productModelRelationHtml = `
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "ProductModel", "@id": "https://shop.example.jp/models/model-1", "name": "モデル親" },
    {
      "@type": "Product",
      "@id": "https://shop.example.jp/products/child-1",
      "isVariantOf": { "@id": "https://shop.example.jp/models/model-1" },
      "name": "子商品 Mサイズ",
      "sku": "MODEL-CHILD-M",
      "gtin13": "4901234567894",
      "url": "https://shop.example.jp/products/child-1"
    }
  ]
}
</script>`;
const productModelVariants = parseCanonicalMarketplaceVariantEvidence(productModelRelationHtml, "https://shop.example.jp/products/parent");
assert.equal(productModelVariants.length, 1, "accept a child Product whose isVariantOf points to a ProductModel");
assert.equal(productModelVariants[0].sourceVariantId, "MODEL-CHILD-M");
assert.equal(productModelVariants[0].gtin, "4901234567894");
assert.equal(productModelVariants[0].evidenceSource, "schema_org_product_is_variant_of");

const productGroupIdHtml = `
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "バリエーション子商品",
  "sku": "GROUP-ID-CHILD",
  "gtin13": "4901234567894",
  "inProductGroupWithID": "GROUP-123",
  "url": "https://shop.example.jp/products/group-child"
}
</script>`;
const groupIdVariants = parseCanonicalMarketplaceVariantEvidence(productGroupIdHtml, "https://shop.example.jp/products/group-parent");
assert.equal(groupIdVariants.length, 1, "accept explicit inProductGroupWithID even when the ProductGroup node is not embedded");
assert.equal(groupIdVariants[0].sourceVariantId, "GROUP-ID-CHILD");
assert.equal(groupIdVariants[0].evidenceSource, "schema_org_product_is_variant_of");
assert.equal(groupIdVariants[0].rawEvidence.relation, "Product.inProductGroupWithID");
assert.equal(groupIdVariants[0].rawEvidence.inProductGroupWithID, "GROUP-123");
const relationDiagnostics = inspectCanonicalMarketplaceVariantMarkup(
  productModelRelationHtml + productGroupIdHtml,
);
assert.equal(relationDiagnostics.productModelCount, 1);
assert.equal(relationDiagnostics.isVariantOfProductCount, 1);
assert.equal(relationDiagnostics.inProductGroupWithIdCount, 1);
assert.equal(relationDiagnostics.childProductsWithExplicitParentRelation, 2);





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


const alternateVariationHtml = `
<script>
var asinVariationValues = {"B0CHILD005":["ホワイト","M"],"B0CHILD006":["ブラック","L"]};
</script>`;
assert.deepEqual(
  parseAmazonVariationAsinMap(alternateVariationHtml, parentUrl),
  [
    { asin: "B0CHILD005", variationValues: ["ホワイト", "M"] },
    { asin: "B0CHILD006", variationValues: ["ブラック", "L"] },
  ],
  "recognize the alternate explicit asinVariationValues map without weakening child barcode verification",
);

const dimensionToAsinHtml = `
<script>
var dimensionToAsinMap = {"[\\"Color=Black\\",\\"Size=M\\"]":"B0CHILD007","[\\"Color=Blue\\",\\"Size=L\\"]":"B0CHILD008"};
</script>`;
assert.deepEqual(
  parseAmazonVariationAsinMap(dimensionToAsinHtml, parentUrl),
  [
    { asin: "B0CHILD007", variationValues: ['["Color=Black","Size=M"]'] },
    { asin: "B0CHILD008", variationValues: ['["Color=Blue","Size=L"]'] },
  ],
  "parse Amazon dimension-to-ASIN maps where the dimension tuple is the key",
);

const serializedMapHtml = String.raw`
<script>
var dimensionValuesDisplayData = "{\"B0CHILD009\":[\"Red\",\"Large\"],\"B0CHILD010\":[\"Blue\"]}";
</script>`;
assert.deepEqual(
  parseAmazonVariationAsinMap(serializedMapHtml, parentUrl),
  [
    { asin: "B0CHILD009", variationValues: ["Red", "Large"] },
    { asin: "B0CHILD010", variationValues: ["Blue"] },
  ],
  "decode a JSON-string-encoded Amazon variation map",
);


const quotedPropertyVariationHtml = String.raw`\n<script>\nvar twisterData = {\"dimensionToAsinMap\":{\"[\\\"Color=Red\\\",\\\"Size=M\\\"]\":\"B0CHILD011\",\"[\\\"Color=Blue\\\",\\\"Size=L\\\"]\":\"B0CHILD012\"}};\n</script>`;\nassert.deepEqual(\n  parseAmazonVariationAsinMap(quotedPropertyVariationHtml, parentUrl),\n  [\n    { asin: \"B0CHILD011\", variationValues: ['[\"Color=Red\",\"Size=M\"]'] },\n    { asin: \"B0CHILD012\", variationValues: ['[\"Color=Blue\",\"Size=L\"]'] },\n  ],\n  \"parse quoted dimensionToAsinMap property keys embedded in Amazon twister data\",\n);\n\nconsole.log("Amazon variant parser fixtures: passed");

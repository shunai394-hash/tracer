import assert from "node:assert/strict";
import { parseCanonicalMarketplaceVariantEvidence } from "../lib/market/canonical-variant-evidence.ts";

const html = `<script type="application/ld+json">[
 {"@type":"https://schema.org/ProductGroup","@id":"#g"},
 {"@type":"https://schema.org/Product","isVariantOf":{"@id":"#g"},"sku":"SKU-RED","gtin13":"4006381333931","url":"https://www.amazon.co.jp/dp/B0CHILD001"},
 {"@type":"https://schema.org/Product","isVariantOf":{"@id":"#g"},"sku":"SKU-BLUE","url":"https://www.amazon.co.jp/dp/B0CHILD002"}
]</script>`;
const found = parseCanonicalMarketplaceVariantEvidence(html,"https://www.amazon.co.jp/dp/B0PARENT00");
assert.equal(found.length,2);
assert.equal(found[0].sourceVariantId,"B0CHILD001");
assert.equal(found[0].evidenceSource,"schema_org_product_is_variant_of");
assert.equal(found[0].gtin,"4006381333931");
assert.equal(found[1].sourceVariantId,"B0CHILD002");
assert.equal(found[1].asin,"B0CHILD002");
const orphan = `<script type="application/ld+json">{"@type":"Product","sku":"ORPHAN","isVariantOf":{"@id":"#missing"}}</script>`;
assert.equal(parseCanonicalMarketplaceVariantEvidence(orphan).length,0);
console.log("PASS: isVariantOf child evidence and unresolved-parent rejection");

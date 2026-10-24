import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const admin = await readFile(new URL("../lib/shopify/admin.ts", import.meta.url), "utf8");
const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");

assert.match(admin, /function shopifySeoInput\(/, "Shopify product sync must build SEO metadata");
assert.match(admin, /slice\(0, 70\)/, "SEO title must respect the 70-character limit");
assert.match(admin, /slice\(0, 320\)/, "SEO description must respect the 320-character limit");
assert.match(admin, /seo: shopifySeoInput\(input\)/g, "create and update must both write SEO metadata");
assert.match(admin, /seo \{ title description \}/g, "create and update must request SEO readback");
assert.match(admin, /async function verifyPersistedShopifySeo\(/, "SEO must be checked with a fresh persisted-product read");
assert.match(admin, /query VerifyPersistedProductSeo\(\$id: ID!\)/, "SEO verification must query Shopify after the mutation");
assert.match(admin, /shopify_seo_readback_mismatch_after_\$\{phase\}/, "SEO verification must fail closed when persisted SEO differs");
assert.match(admin, /verifyPersistedShopifySeo\(product\.id, input\.title, expectedSeo, "create"\)/, "create must verify persisted SEO against the product title default");
assert.match(admin, /verifyPersistedShopifySeo\(product\.id, input\.title, expectedSeo, "update"\)/, "update must verify persisted SEO against the product title default");
assert.match(admin, /seo\?\.title == null && expected\.title === data\.product\?\.title/, "null SEO title is accepted only when Shopify can use the product title as default");

console.log("Shopify SEO write, bounds, and readback guards are present.");



test("commerce publishing sends bounded SEO title and description to Shopify create and update", () => {
  assert.match(publish, /const seoTitle =/);
  assert.match(publish, /const seoDescription = storefrontDescription/);
  assert.match(publish, /updateWithHandleCollisionRecovery\(\{[^}]*seoTitle, seoDescription/s);
  assert.match(publish, /createShopifyProduct\(\{[^}]*seoTitle, seoDescription/s);
});

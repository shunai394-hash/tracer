import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupExactColorFamilies } from "../lib/shop/color-family-storefront.ts";

const FAMILIES = [
  { productId: "78440a5e-c95e-4282-bf39-f7885f66dc0f", supplierProductId: "2608270931501632200", name: "Animal print metal-parts women's handbag" },
  { productId: "cda6d104-1036-4d06-a6d7-6896b3bbca79", supplierProductId: "2611030217281638700", name: "Retro design women's handbag" },
  { productId: "7552ee45-64f7-4f9b-8a4c-026f85ec5a97", supplierProductId: "2610130254321621100", name: "Large-capacity crossbody women's handbag" },
];
const COLORS = ["ブラック", "ホワイト", "レッド", "ブルー", "ベージュ"];

function member(family, index, overrides = {}) {
  return {
    id: `${family.productId}-${index}`,
    slug: `${family.supplierProductId}-${index}`,
    title: `${family.name}（${COLORS[index]}）`,
    productId: family.productId,
    supplierName: "cj",
    supplierProductId: family.supplierProductId,
    supplierVariantId: `${family.supplierProductId}-${index}`,
    sku: `SKU-${family.supplierProductId}-${index}`,
    imageUrl: `https://images.example.test/${family.supplierProductId}/${COLORS[index]}.jpg`,
    variantImageIdentityVerified: true,
    sellingPrice: 4980 + index * 100,
    currency: "JPY",
    inventory: 10,
    shopifyVariantId: `gid://shopify/ProductVariant/${family.supplierProductId.slice(-4)}${index}`,
    shopifyHandle: `bag-${family.supplierProductId}`,
    manualInventory: false,
    ...overrides,
  };
}

const catalog = groupExactColorFamilies(FAMILIES.flatMap((family) => COLORS.map((_, index) => member(family, index)))).catalog;
const sellable = catalog.filter((item) => !item.colorSaleBlocked);
assert.equal(sellable.length, 3);
for (const family of FAMILIES) {
  const card = sellable.find((item) => item.productId === family.productId && item.supplierProductId === family.supplierProductId);
  assert.ok(card, family.supplierProductId);
  assert.equal(card.variants.length, 5);
  assert.equal(new Set(card.variants.map((variant) => variant.supplierVariantId)).size, 5);
  assert.equal(new Set(card.variants.map((variant) => variant.sku)).size, 5);
  assert.equal(new Set(card.variants.map((variant) => variant.imageUrl)).size, 5);
  assert.equal(card.title.includes("（"), false);
}

const sharedImage = groupExactColorFamilies([
  member(FAMILIES[0], 0),
  member(FAMILIES[0], 1, { imageUrl: member(FAMILIES[0], 0).imageUrl }),
]).catalog;
assert.equal(sharedImage.length, 2);
assert.ok(sharedImage.every((item) => item.colorSaleBlocked === true));
assert.ok(sharedImage.every((item) => item.colorSaleBlockers.some((blocker) => blocker.startsWith("color_family_unverified:"))));
assert.ok(sharedImage.every((item) => item.variants.length === 0));

const missingImages = groupExactColorFamilies([
  member(FAMILIES[0], 0, { imageUrl: null }),
  member(FAMILIES[0], 1, { imageUrl: null }),
]).catalog;
assert.equal(missingImages.length, 2);
assert.ok(missingImages.every((item) => item.colorSaleBlocked === true));
assert.ok(missingImages.every((item) => item.colorSaleBlockers.some((blocker) => blocker.startsWith("color_family_unverified:"))));
assert.ok(missingImages.every((item) => item.variants.length === 0));

const differentProducts = groupExactColorFamilies([
  member(FAMILIES[0], 0, { title: "同じ名前（ブラック）" }),
  member(FAMILIES[1], 0, { title: "同じ名前（ブラック）" }),
]).catalog.filter((item) => !item.colorSaleBlocked);
assert.equal(differentProducts.length, 2);

const conflict = groupExactColorFamilies([
  member(FAMILIES[0], 0),
  member(FAMILIES[0], 1, { productId: "11111111-1111-4111-8111-111111111111" }),
]).catalog;
assert.equal(conflict.every((item) => item.colorSaleBlocked), true);
assert.ok(conflict.every((item) => item.variants.length === 0));

const proteinId = "1ae04dd1-a228-43b7-b003-3a2fb75da98a";
const protein = groupExactColorFamilies([
  member(FAMILIES[0], 0, { id: proteinId, manualInventory: true, supplierProductId: FAMILIES[0].supplierProductId, title: "BEAUTY FORMULA チョコレート風味プロテイン 300g" }),
  member(FAMILIES[0], 1),
]).catalog;
const unverifiedImageIdentity = groupExactColorFamilies([
  member(FAMILIES[0], 0, { variantImageIdentityVerified: false }),
  member(FAMILIES[0], 1, { colorImageVerified: false }),
]).catalog;
assert.equal(unverifiedImages.length, 2);
assert.ok(unverifiedImages.every((item) => item.colorSaleBlocked === true));
assert.ok(unverifiedImages.every((item) => item.colorSaleBlockers.some((blocker) => blocker.startsWith("color_family_unverified:"))));

const missingLabels = groupExactColorFamilies([
  member(FAMILIES[0], 0, { title: "レディース ハンドバッグ" }),
  member(FAMILIES[0], 1, { title: "レディース ハンドバッグ" }),
]).catalog;
assert.equal(missingLabels.length, 2);
assert.ok(missingLabels.every((item) => item.colorSaleBlocked === true));
assert.ok(missingLabels.every((item) => item.colorSaleBlockers.some((blocker) => blocker.startsWith("color_family_unverified:"))));
assert.ok(missingLabels.every((item) => item.variants.length === 0));

const missingSku = groupExactColorFamilies([
  member(FAMILIES[0], 0, { sku: null }),
  member(FAMILIES[0], 1, { sku: null }),
]).catalog;
assert.equal(missingSku[0].colorSaleBlocked, true);
assert.ok(missingSku[0].colorSaleBlockers.some((blocker) => blocker.startsWith("color_family_unverified:") && blocker.includes("sku_missing")));
const orderIdentity = groupExactColorFamilies([
  member(FAMILIES[0], 0, { sku: null }),
  member(FAMILIES[0], 1, { sku: null }),
], { requireSku: false }).catalog;
assert.equal(orderIdentity[0].colorSaleBlocked, false);
assert.equal(orderIdentity[0].variants[0].supplierVariantId, member(FAMILIES[0], 0).supplierVariantId);

const proteinCard = protein.find((item) => item.id === proteinId);
assert.equal(proteinCard.colorSaleBlocked, false);
assert.equal(proteinCard.variants.length, 0);

const page = readFileSync(new URL("../app/shop/[slug]/page.tsx", import.meta.url), "utf8");
const cart = readFileSync(new URL("../components/shop-cart.ts", import.meta.url), "utf8");
const button = readFileSync(new URL("../components/add-to-cart-button.tsx", import.meta.url), "utf8");
const store = readFileSync(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
assert.match(store, /variantImageIdentityVerified: attributes\.variantImageIdentityVerified === true/);
assert.match(page, /ProductVariantSelector/);
assert.match(page, /saleBlocked=\{listing\.colorSaleBlocked === true\}/);
assert.match(cart, /supplierVariantId\?: string \| null/);
assert.match(button, /supplierVariantId: props\.supplierVariantId/);
assert.match(store, /color_family_unverified/);
assert.match(store, /row\.colorSaleBlocked !== true/);
assert.match(store, /supplier_variant_id: line\.listing\.supplier_variant_id/);
assert.match(store, /colorSelections/);

console.log("storefront color family: 15 synthetic variants, exact supplier-image identity, image-gap sales fallback, and cart identity passed");

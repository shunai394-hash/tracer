import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateSellingPrice } from "../lib/commerce/pricing.mjs";
import {
  findRefusedTitleGroups,
  newfindFamilyPayload,
  planVariantFamily,
  resolveBaseOrderVariant,
  resolveShopifyOrderVariant,
  sharedParentTitle,
} from "../lib/commerce/variant-family.mjs";

const fee = { feeRate: 0.066, fixedFeeJpy: 0, targetMarginRate: 0.5 };

function member(overrides) {
  return {
    productId: "product-1",
    variantId: "11111111-1111-4111-8111-111111111111",
    supplierProductId: "1234567890123",
    supplierVariantId: "9876543210987",
    sku: "",
    title: "ヘアクリップ（ブラック）",
    supplierVariantName: "Black",
    sellingPrice: 4980,
    marginRate: 0.52,
    inventory: 8,
    evidenceFresh: true,
    missingEvidence: [],
    existingExternalProductId: null,
    existingExternalVariantId: null,
    ...overrides,
  };
}

test("same supplier product keeps color variants on one parent and withholds incomplete ones", () => {
  const cheap = calculateSellingPrice({ unitCostJpy: 800, shippingCostJpy: 600, ...fee });
  const rich = calculateSellingPrice({ unitCostJpy: 1500, shippingCostJpy: 900, ...fee });
  assert.ok(cheap.marginRate >= 0.5);
  assert.ok(rich.marginRate >= 0.5);
  assert.ok(rich.sellingPrice > cheap.sellingPrice);

  const plan = planVariantFamily({
    productId: "product-1",
    sourceKey: "cj:1234567890123",
    productTitle: "ヘアクリップ（ブラック）",
    members: [
      member({ sellingPrice: cheap.sellingPrice, marginRate: cheap.marginRate, title: "ヘアクリップ（ブラック）" }),
      member({
        variantId: "22222222-2222-4222-8222-222222222222",
        supplierVariantId: "9876543210988",
        title: "ヘアクリップ（ホワイト）",
        supplierVariantName: "White",
        sellingPrice: rich.sellingPrice,
        marginRate: rich.marginRate,
      }),
      member({
        variantId: "33333333-3333-4333-8333-333333333333",
        supplierVariantId: "9876543210989",
        title: "ヘアクリップ（レッド）",
        supplierVariantName: "Red",
        missingEvidence: ["domestic_shipping"],
        inventory: 4,
      }),
      member({
        variantId: "44444444-4444-4444-8444-444444444444",
        supplierVariantId: "",
        title: "ヘアクリップ（ブルー）",
      }),
    ],
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.productTitle, "ヘアクリップ");
  assert.deepEqual(plan.axes, ["色"]);
  assert.equal(plan.basePricePolicy, "highest_variant_price");
  assert.equal(plan.basePrice, rich.sellingPrice);
  assert.equal(plan.variations.length, 3);
  assert.equal(plan.variations.find((row) => row.label === "レッド").inventory, 0);
  assert.equal(plan.variations.find((row) => row.label === "レッド").sellable, false);
  assert.equal(plan.excluded.length, 1);
  assert.equal(plan.excluded[0].reason, "supplier_identity_incomplete");
  assert.notEqual(plan.variations[0].sku, plan.variations[1].sku);
  assert.match(plan.variations[0].imageAlt, /ヘアクリップ/);
});

test("different supplier product ids are never merged, even when the titles match", () => {
  const conflict = planVariantFamily({
    productId: "product-1",
    sourceKey: "cj:mixed",
    productTitle: "ヘアクリップ",
    members: [
      member({ supplierProductId: "1234567890123" }),
      member({
        variantId: "22222222-2222-4222-8222-222222222222",
        supplierProductId: "1234567890999",
        supplierVariantId: "9876543210001",
        title: "ヘアクリップ（ホワイト）",
      }),
    ],
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "supplier_product_id_conflict");

  const refused = findRefusedTitleGroups([
    { productId: "a", title: "ヘアクリップ（ブラック）", supplierProductId: "1111111111111", variantCount: 1 },
    { productId: "b", title: "ヘアクリップ（ホワイト）", supplierProductId: "2222222222222", variantCount: 1 },
    { productId: "c", title: "別の商品（ブラック）", supplierProductId: "3333333333333", variantCount: 2 },
  ]);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].title, "ヘアクリップ");
  assert.equal(refused[0].products.length, 2);
});

test("a below-target margin stays unsold and identical option labels are rejected", () => {
  const low = planVariantFamily({
    productId: "product-1",
    sourceKey: "cj:1234567890123",
    productTitle: "ヘアクリップ",
    members: [
      member({ marginRate: 0.49 }),
      member({
        variantId: "22222222-2222-4222-8222-222222222222",
        supplierVariantId: "9876543210988",
        title: "ヘアクリップ（ホワイト）",
      }),
    ],
  });
  assert.equal(low.ok, true);
  assert.equal(low.variations.find((row) => row.variantId.startsWith("1111")).sellable, false);
  assert.equal(low.variations.find((row) => row.variantId.startsWith("1111")).withheldReason, "margin_below_target");
  assert.equal(low.visible, true);

  const collision = planVariantFamily({
    productId: "product-1",
    sourceKey: "cj:1234567890123",
    productTitle: "ヘアクリップ",
    members: [
      member(),
      member({
        variantId: "22222222-2222-4222-8222-222222222222",
        supplierVariantId: "9876543210988",
        title: "ヘアクリップ（ブラック）",
        supplierVariantName: "Black",
      }),
    ],
  });
  assert.equal(collision.ok, false);
  assert.equal(collision.reason, "variation_label_collision");
});

test("orders keep the selected variation and its CJ variant id", () => {
  const listings = [
    { status: "published", variantId: "black", externalProductId: "100", externalVariantId: "11", externalSku: "TRC-BLACK", supplierVariantId: "cj-black" },
    { status: "published", variantId: "white", externalProductId: "100", externalVariantId: "12", externalSku: "TRC-WHITE", supplierVariantId: "cj-white" },
  ];
  assert.deepEqual(
    resolveBaseOrderVariant({ itemId: "100", variationId: "12", variationIdentifier: "TRC-WHITE" }, listings),
    { ok: true, variantId: "white", supplierVariantId: "cj-white" },
  );
  assert.equal(resolveBaseOrderVariant({ itemId: "100" }, listings).ok, false);
  assert.equal(
    resolveBaseOrderVariant({ itemId: "55" }, [{ ...listings[0], externalProductId: "55" }]).variantId,
    "black",
  );
  assert.equal(
    resolveShopifyOrderVariant({
      shopifyVariantGid: "gid://shopify/ProductVariant/12",
      sku: "TRC-BLACK",
    }, listings.map((row, index) => ({ ...row, externalVariantId: "gid://shopify/ProductVariant/" + (11 + index) }))).reason,
    "shopify_variant_sku_conflict",
  );
  const selected = resolveShopifyOrderVariant({
    shopifyVariantGid: "gid://shopify/ProductVariant/12",
    sku: "TRC-WHITE",
  }, listings.map((row, index) => ({ ...row, externalVariantId: "gid://shopify/ProductVariant/" + (11 + index) })));
  assert.equal(selected.supplierVariantId, "cj-white");
});

test("twenty-seven parent products group only their own colors and sizes", () => {
  const products = Array.from({ length: 27 }, (_, index) => {
    const productId = "p" + String(index + 1).padStart(2, "0");
    const supplierProductId = String(8000000000000 + index);
    const colors = index % 5 === 0 ? ["ブラック", "ホワイト", "ベージュ"] : index % 2 === 0 ? ["S", "M"] : ["標準"];
    return {
      productId,
      title: "推奨商品" + productId,
      supplierProductId,
      colors,
    };
  });
  const plans = products.map((product) => planVariantFamily({
    productId: product.productId,
    sourceKey: "cj:" + product.supplierProductId,
    productTitle: product.title,
    members: product.colors.map((label, colorIndex) => member({
      productId: product.productId,
      variantId: product.productId + "-v" + colorIndex,
      supplierProductId: product.supplierProductId,
      supplierVariantId: product.supplierProductId + colorIndex,
      title: product.title + "（" + label + "）",
      supplierVariantName: label,
    })),
  }));
  const grouped = plans.filter((plan) => plan.ok);
  const singles = plans.filter((plan) => !plan.ok && plan.reason === "variant_family_too_small");
  assert.equal(products.length, 27);
  assert.equal(grouped.length + singles.length, 27);
  assert.ok(grouped.length > 0);
  for (const plan of grouped) {
    assert.equal(new Set(plan.variations.map((row) => row.supplierProductId)).size, 1);
    assert.equal(new Set(plan.variations.map((row) => row.supplierVariantId)).size, plan.variations.length);
  }
  assert.equal(sharedParentTitle(["推奨商品p02（S）", "推奨商品p02（M）"]), "推奨商品p02");
  const payload = newfindFamilyPayload([
    { id: "v1", productId: "p02", title: "推奨商品p02（S）", sellingPrice: 3000, inventory: 2, supplierVariantId: "cj-s", sku: "TRC-S", url: "https://shop.example/products/p02" },
    { id: "v2", productId: "p02", title: "推奨商品p02（M）", sellingPrice: 3200, inventory: 1, supplierVariantId: "cj-m", sku: "TRC-M", url: "https://shop.example/products/p02" },
  ]);
  assert.equal(payload.product_name, "推奨商品p02");
  assert.equal(payload.variations.length, 2);
  assert.deepEqual(payload.variations.map((row) => row.supplier_variant_id), ["cj-s", "cj-m"]);
});

test("family sync keeps listings, backs up identity, and does not delete channel products", () => {
  const sync = readFileSync("lib/commerce/sync-variant-family.ts", "utf8");
  const publish = readFileSync("lib/commerce/publish.ts", "utf8");
  const baseOrders = readFileSync("app/api/cron/commerce-base-orders/route.ts", "utf8");
  const paid = readFileSync("app/api/webhooks/shopify/orders-paid/route.ts", "utf8");
  const procurement = readFileSync("app/api/cron/commerce-procurement/route.ts", "utf8");
  assert.match(sync, /channel_listing_identity_backup/);
  assert.match(sync, /productSet/);
  assert.match(sync, /variation_identifier/);
  assert.match(sync, /cj_variant_id/);
  assert.doesNotMatch(sync, /\.delete\(/);
  assert.match(publish, /syncQueuedVariantFamilies/);
  assert.match(publish, /variant_family_deferred/);
  assert.match(baseOrders, /resolveBaseOrderVariant/);
  assert.match(paid, /gid:\/\/shopify\/ProductVariant\//);
  assert.match(paid, /tracer_sku_mapping_missing/);
  assert.match(procurement, /offer\.supplier_variant_id !== row\.supplier_variant_id/);
  assert.match(procurement, /liveMarginRate < 0\.5/);
});

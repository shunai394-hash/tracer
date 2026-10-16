import assert from "node:assert/strict";
import test from "node:test";
import { canFulfillOffer, canPublishJapaneseCatalogItem, externalOrderKey, quoteSellingPrice } from "../lib/rebuild/commerce-core.ts";

test("publication is independent of supplier fulfillment readiness", () => {
  assert.deepEqual(canPublishJapaneseCatalogItem({ titleJa: "商品", descriptionJa: "説明", imageUrls: ["https://img.example/item.jpg"], sellingPrice: 1980 }), { ok: true, reasons: [] });
  const offer = { supplierCode: "CJ", supplierProductId: "p1", supplierVariantId: "v1", sourceCost: 500, shippingCost: 100, stockQuantity: 0, shipTo: "JP", orderable: false, trackingAvailable: false };
  assert.equal(canFulfillOffer(offer, 1).ok, false);
});

test("price quote covers landed cost and fees with configured margin", () => {
  const quote = quoteSellingPrice({ sourceCost: 500, shippingCost: 100, marketplaceFeeRate: 0.06, paymentFeeRate: 0.035, targetMarginRate: 0.2 });
  assert.ok(quote.sellingPrice > 600);
  assert.ok(quote.estimatedProfit > 0);
  assert.ok(quote.estimatedMarginRate >= 0.2);
});

test("orders are idempotently keyed by channel and external ID", () => {
  assert.equal(externalOrderKey("shopify", "123"), "shopify:123");
  assert.notEqual(externalOrderKey("base", "123"), externalOrderKey("shopify", "123"));
  assert.throws(() => externalOrderKey("base", " "));
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const productPage = await readFile(new URL("../app/shop/[slug]/page.tsx", import.meta.url), "utf8");

test("global focus indicator uses a clear 3px dark ring", () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus-ring\)/s);
  assert.match(css, /--focus-ring:\s*#3b241a/i);
});

test("reduced-motion preference disables smooth scrolling and minimizes transitions", () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /html\s*\{\s*scroll-behavior:\s*auto;/s);
  assert.match(css, /transition-duration:\s*0\.01ms\s*!important/);
  assert.match(css, /animation-duration:\s*0\.01ms\s*!important/);
});

test("product detail avoids unsupported shipping and fulfillment promises", () => {
  assert.ok(productPage.includes('<span className="text-xs text-neutral-500">表示価格</span>'));
  assert.doesNotMatch(productPage, /税込・送料込み|送料込みの価格表示|送料が含まれています|追跡番号付き/);
  assert.ok(productPage.includes("送料・配送条件は購入手続き画面でご確認ください。"));
});

test("product metadata uses whitespace normalization and absolute encoded URLs", () => {
  assert.ok(productPage.includes('.replace(/\\\\s+/g, " ")'));
  assert.ok(productPage.includes('new URL(`/shop/${encodeURIComponent(listing.slug)}`, siteUrl).toString()'));
  assert.ok(productPage.includes("aspect-[4/5] w-full object-cover"));
});

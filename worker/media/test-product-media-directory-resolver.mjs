import assert from "node:assert/strict";
import { createProductMediaDirectoryResolver } from "./product-media-directory-resolver.mjs";

const existing = new Set([
  "/media/products/shop-101.mp4",
  "/media/products/shop-202.mp4",
  "/media/bgm/shop-202.mp3",
]);
const resolver = createProductMediaDirectoryResolver({
  mediaRoot: "/media",
  fileExists: async (file) => existing.has(file),
});

assert.deepEqual(await resolver("shop-101"), {
  videoFile: "products/shop-101.mp4",
});
assert.deepEqual(await resolver("shop-202"), {
  videoFile: "products/shop-202.mp4",
  bgmFile: "bgm/shop-202.mp3",
});
await assert.rejects(() => resolver("unknown"), /product_video_asset_missing/);
await assert.rejects(() => resolver("../escape"), /product_id_invalid/);
await assert.rejects(() => resolver(""), /product_id_invalid/);
assert.throws(
  () => createProductMediaDirectoryResolver({ mediaRoot: "/media", fileExists: null }),
  /directory_configuration_required/,
);
console.log("AI Live product media directory resolver: all assertions passed");

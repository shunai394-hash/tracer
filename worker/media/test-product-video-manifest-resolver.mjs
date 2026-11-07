import assert from "node:assert/strict";
import { createProductMediaManifestResolver, createProductVideoManifestResolver } from "./product-video-manifest-resolver.mjs";

const manifest = JSON.stringify({
  products: {
    "shop-101": { videoFile: "products/shop-101.mp4" },
    "shop-202": { videoFile: "products/shop-202.mov", bgmFile: "bgm/ambient.mp3" },
  },
});
const resolver = createProductMediaManifestResolver({
  manifestPath: "/app/media/manifest.json",
  mediaRoot: "/app/media",
  readFileImpl: async () => manifest,
});
assert.deepEqual(await resolver("shop-101"), { videoFile: "products/shop-101.mp4" });
assert.deepEqual(await resolver("shop-202"), { videoFile: "products/shop-202.mov", bgmFile: "bgm/ambient.mp3" });
const videoOnly = createProductVideoManifestResolver({
  manifestPath: "/app/media/manifest.json",
  mediaRoot: "/app/media",
  readFileImpl: async () => manifest,
});
assert.equal(await videoOnly("shop-202"), "products/shop-202.mov");
await assert.rejects(() => resolver("unknown"), /media_mapping_missing/);
const traversal = createProductMediaManifestResolver({
  manifestPath: "/app/media/manifest.json",
  mediaRoot: "/app/media",
  readFileImpl: async () => JSON.stringify({ products: { bad: { videoFile: "../outside.mp4" } } }),
});
await assert.rejects(() => traversal("bad"), /path_outside_root/);
const wrongType = createProductMediaManifestResolver({
  manifestPath: "/app/media/manifest.json",
  mediaRoot: "/app/media",
  readFileImpl: async () => JSON.stringify({ products: { bad: { videoFile: "products/bgm.mp3" } } }),
});
await assert.rejects(() => wrongType("bad"), /extension_invalid/);
assert.throws(() => createProductMediaManifestResolver({
  manifestPath: "/etc/passwd",
  mediaRoot: "/app/media",
}), /manifest_outside_media_root/);
console.log("AI Live product video manifest resolver: all assertions passed");

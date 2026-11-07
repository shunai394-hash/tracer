import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Resolves product media by the canonical TRACER shop_listings.id.
 *
 * Asset convention:
 *   /app/media/products/<product-id>.mp4
 *   /app/media/bgm/<product-id>.mp3  (optional; session BGM is the fallback)
 *
 * This removes the per-product JSON manifest requirement. Assets remain
 * operator-provided and are never downloaded from product-supplied URLs.
 */
export function createProductMediaDirectoryResolver({
  mediaRoot = process.env.AI_LIVE_MEDIA_ROOT || "/app/media",
  fileExists = async (file) => {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  },
} = {}) {
  if (typeof mediaRoot !== "string" || !mediaRoot.trim() ||
      typeof fileExists !== "function") {
    throw new Error("ai_live_media_directory_configuration_required");
  }
  const root = path.resolve(mediaRoot);

  function resolveRelative(relative) {
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new Error("ai_live_media_path_outside_root");
    }
    return { absolute, relative: path.relative(root, absolute) };
  }

  return async function resolveProductMedia(productId) {
    if (typeof productId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(productId)) {
      throw new Error("ai_live_media_product_id_invalid");
    }

    const video = resolveRelative(`products/${productId}.mp4`);
    if (!await fileExists(video.absolute)) {
      throw new Error("ai_live_product_video_asset_missing");
    }

    const bgm = resolveRelative(`bgm/${productId}.mp3`);
    const hasProductBgm = await fileExists(bgm.absolute);

    return {
      videoFile: video.relative,
      ...(hasProductBgm ? { bgmFile: bgm.relative } : {}),
    };
  };
}

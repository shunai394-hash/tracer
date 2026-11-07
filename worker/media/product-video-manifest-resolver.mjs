import { readFile } from "node:fs/promises";
import path from "node:path";

function safeMediaFile(value, mediaRoot, kind) {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new Error("ai_live_media_manifest_file_invalid");
  }
  const root = path.resolve(mediaRoot);
  const file = path.resolve(root, value);
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new Error("ai_live_media_manifest_path_outside_root");
  }
  const extension = path.extname(file).toLowerCase();
  const allowed = kind === "video"
    ? new Set([".mp4", ".mov", ".mkv"])
    : new Set([".mp3", ".wav", ".m4a"]);
  if (!allowed.has(extension)) throw new Error("ai_live_media_manifest_extension_invalid");
  return path.relative(root, file);
}

/**
 * Resolves only operator-curated media entries. The manifest contains product
 * IDs and relative media paths, never URLs or credentials. A missing mapping
 * is a hard error: the session must not silently play an unrelated product.
 */
export function createProductVideoManifestResolver({
  manifestPath = process.env.AI_LIVE_MEDIA_MANIFEST || "/app/media/manifest.json",
  mediaRoot = process.env.AI_LIVE_MEDIA_ROOT || "/app/media",
  readFileImpl = readFile,
} = {}) {
  if (typeof manifestPath !== "string" || !manifestPath.trim() ||
      typeof readFileImpl !== "function") {
    throw new Error("ai_live_media_manifest_configuration_required");
  }
  const absoluteManifestPath = path.resolve(manifestPath);
  const root = path.resolve(mediaRoot);
  if (absoluteManifestPath !== root && !absoluteManifestPath.startsWith(root + path.sep)) {
    throw new Error("ai_live_media_manifest_outside_media_root");
  }

  let cached = null;
  let cachedMtime = null;
  async function loadManifest() {
    const stat = await import("node:fs/promises").then((fs) => fs.stat(absoluteManifestPath));
    if (cached && cachedMtime === stat.mtimeMs) return cached;
    const raw = await readFileImpl(absoluteManifestPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
      throw new Error("ai_live_media_manifest_too_large");
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error("ai_live_media_manifest_invalid_json"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        !parsed.products || typeof parsed.products !== "object" || Array.isArray(parsed.products)) {
      throw new Error("ai_live_media_manifest_invalid_shape");
    }
    const entries = Object.entries(parsed.products);
    if (entries.length > 5000) throw new Error("ai_live_media_manifest_too_many_products");
    const next = new Map();
    for (const [productId, value] of entries) {
      if (!productId || productId.length > 128 || !value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("ai_live_media_manifest_invalid_entry");
      }
      next.set(productId, {
        videoFile: safeMediaFile(value.videoFile, root, "video"),
        ...(value.bgmFile ? { bgmFile: safeMediaFile(value.bgmFile, root, "bgm") } : {}),
      });
    }
    cached = next;
    cachedMtime = stat.mtimeMs;
    return cached;
  }

  return async function resolveVideoForProduct(productId) {
    if (typeof productId !== "string" || !productId.trim() || productId.length > 128) {
      throw new Error("ai_live_media_product_id_invalid");
    }
    const manifest = await loadManifest();
    const entry = manifest.get(productId);
    if (!entry) throw new Error("ai_live_media_mapping_missing");
    return entry.videoFile;
  };
}

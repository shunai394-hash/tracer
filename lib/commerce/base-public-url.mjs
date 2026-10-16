function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function safeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a BASE item URL only from an API-returned public URL or an explicitly
 * configured public shop domain. Never point customers at the generic BASE homepage.
 */
export function resolveBasePublicUrl(response, itemId, publicShopUrl = "") {
  const root = record(response);
  const item = record(root.item);
  const candidates = [
    item.item_url, item.itemUrl, item.url,
    root.item_url, root.itemUrl, root.url,
  ];
  for (const candidate of candidates) {
    const url = safeHttpUrl(candidate);
    if (url) return url;
  }

  const id = String(itemId ?? "").trim();
  const shopUrl = safeHttpUrl(publicShopUrl);
  if (!id || !shopUrl) return null;
  try {
    const base = new URL(shopUrl);
    return new URL("/items/" + encodeURIComponent(id), base.origin).toString();
  } catch {
    return null;
  }
}

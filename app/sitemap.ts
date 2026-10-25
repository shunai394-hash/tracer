import type { MetadataRoute } from "next";
import { listPublishedShopListings } from "@/lib/shop/store";
import { STOREFRONT_CATEGORIES, categoryOf } from "@/lib/shop/storefront-display";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://tracer-pied-alpha.vercel.app").replace(/\/$/, "");
const UUID_SLUG = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const fixed: MetadataRoute.Sitemap = [
    { url: SITE_URL, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/shop`, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE_URL}/privacy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${SITE_URL}/terms`, changeFrequency: "yearly", priority: 0.2 },
  ];

  try {
    const listings = await listPublishedShopListings();
    const seenProductUrls = new Set<string>();
    const products: MetadataRoute.Sitemap = listings
      .filter((item) => {
        if (typeof item.slug !== "string") return false;
        const slug = item.slug.trim();
        if (!slug || UUID_SLUG.test(slug)) return false;
        const url = `${SITE_URL}/shop/${encodeURIComponent(slug)}`;
        if (seenProductUrls.has(url)) return false;
        seenProductUrls.add(url);
        return true;
      })
      .map((item) => ({
        url: `${SITE_URL}/shop/${encodeURIComponent(item.slug.trim())}`,
        changeFrequency: "weekly",
        priority: 0.7,
      }));
    const availableCategories = new Set(listings.map((item) => categoryOf(item.title)));
    const categories: MetadataRoute.Sitemap = STOREFRONT_CATEGORIES
      .filter((category) => availableCategories.has(category.slug))
      .map((category) => ({
        url: `${SITE_URL}/shop?cat=${encodeURIComponent(category.slug)}`,
        changeFrequency: "daily",
        priority: 0.8,
      }));
    return [...fixed, ...categories, ...products];
  } catch {
    // Keep the core storefront discoverable if the catalog is temporarily unavailable.
    return fixed;
  }
}

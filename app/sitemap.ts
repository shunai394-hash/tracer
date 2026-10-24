import type { MetadataRoute } from "next";
import { listPublishedShopListings } from "@/lib/shop/store";
import { STOREFRONT_CATEGORIES } from "@/lib/shop/storefront-display";

const SITE_URL = "https://tracer-pied-alpha.vercel.app";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const fixed: MetadataRoute.Sitemap = [
    { url: SITE_URL, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/shop`, changeFrequency: "daily", priority: 0.9 },
    ...STOREFRONT_CATEGORIES.map((category) => ({ url: `${SITE_URL}/shop/category/${category.slug}`, changeFrequency: "daily" as const, priority: 0.8 })),
    { url: `${SITE_URL}/privacy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${SITE_URL}/terms`, changeFrequency: "yearly", priority: 0.2 },
  ];

  try {
    const listings = await listPublishedShopListings();
    const products: MetadataRoute.Sitemap = listings
      .filter((item) => typeof item.slug === "string" && item.slug.length > 0)
      .map((item) => ({
        url: `${SITE_URL}/shop/${encodeURIComponent(item.slug)}`,
        changeFrequency: "weekly",
        priority: 0.7,
      }));
    return [...fixed, ...products];
  } catch {
    // Keep the core storefront discoverable if the catalog is temporarily unavailable.
    return fixed;
  }
}

import type { MetadataRoute } from "next";
import { listPublishedShopListings } from "@/lib/shop/store";
import { STOREFRONT_CATEGORIES, categoryOf } from "@/lib/shop/storefront-display";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://tracer-pied-alpha.vercel.app").replace(/\/$/, "");

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const fixed: MetadataRoute.Sitemap = [
    { url: SITE_URL, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/shop`, changeFrequency: "daily", priority: 0.9 },
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

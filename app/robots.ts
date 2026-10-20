import type { MetadataRoute } from "next";

const SITE_URL = "https://tracer-pied-alpha.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/mypage/", "/settings/", "/orders/", "/shop/cart", "/shop/checkout"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}

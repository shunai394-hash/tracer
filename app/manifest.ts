import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TRACER — AI Commerce Intelligence",
    short_name: "TRACER",
    description: "Track products, brands, prices, demand, and supply across world markets.",
    start_url: "/",
    display: "standalone",
    background_color: "#02040b",
    theme_color: "#02040b",
    icons: [
      { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}

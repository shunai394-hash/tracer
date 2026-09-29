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
      { src: "/icon.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "512x512", type: "image/svg+xml", purpose: "maskable" }
    ]
  };
}

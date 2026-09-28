import { NextResponse } from "next/server";

import {
  runProductIntelligence,
  type ProductIntelligenceInput,
} from "@/lib/intelligence/product-api";

export const runtime = "nodejs";

function normalizeBody(body: Record<string, unknown>): ProductIntelligenceInput {
  return {
    asin: typeof body.asin === "string" ? body.asin : null,
    jan: typeof body.jan === "string" ? body.jan : null,
    gtin: typeof body.gtin === "string" ? body.gtin : null,
    ean: typeof body.ean === "string" ? body.ean : null,
    upc: typeof body.upc === "string" ? body.upc : null,
    mpn: typeof body.mpn === "string" ? body.mpn : null,
    url: typeof body.url === "string" ? body.url : null,
    title: typeof body.title === "string" ? body.title : null,
    brand: typeof body.brand === "string" ? body.brand : null,
    imageUrl:
      typeof body.imageUrl === "string"
        ? body.imageUrl
        : typeof body.image_url === "string"
          ? body.image_url
          : null,
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { ok: false, error: "JSON object is required" },
        { status: 400 },
      );
    }

    const input = normalizeBody(body as Record<string, unknown>);
    const hasIdentifier = Boolean(
      input.asin ||
      input.jan ||
      input.gtin ||
      input.ean ||
      input.upc ||
      input.mpn ||
      input.url,
    );

    if (!hasIdentifier) {
      return NextResponse.json(
        {
          ok: false,
          error: "at least one identifier or product URL is required",
        },
        { status: 400 },
      );
    }

    const result = await runProductIntelligence(input);

    return NextResponse.json({
      ok: true,
      apiVersion: "1",
      result,
    });
  } catch (error) {
    console.error("[TRACER PRODUCT INTELLIGENCE API ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

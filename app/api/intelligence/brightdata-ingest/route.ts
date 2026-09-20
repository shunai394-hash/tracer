import { NextResponse } from "next/server";
import {
  BrightDataConfigError,
  BrightDataRequestError,
  searchGoogleProducts,
} from "@/lib/sources/brightdata/client";
import { persistBrightDataProducts } from "@/lib/tracer/persist-brightdata";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    const query =
      typeof body?.query === "string"
        ? body.query.trim()
        : "wireless earbuds";

    if (!query) {
      return NextResponse.json(
        { ok: false, error: "query is required" },
        { status: 400 },
      );
    }

    console.log("[BRIGHTDATA INGEST] request query =", JSON.stringify(query));
    const result = await searchGoogleProducts(query);
    console.log("[BRIGHTDATA INGEST] result query =", JSON.stringify(result.query));

    const persisted = await persistBrightDataProducts(
      result.query,
      result.products,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        query: result.query,
        fetched: result.products.length,
        persisted,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  } catch (error) {
    console.error("[TRACER INGEST ERROR]", error);

    if (error instanceof BrightDataConfigError) {
      return NextResponse.json(
        { ok: false, error: error.code, message: error.message },
        { status: 500 },
      );
    }

    if (error instanceof BrightDataRequestError) {
      return NextResponse.json(
        { ok: false, error: error.code, message: error.message },
        { status: 502 },
      );
    }

    const message =
      error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        ok: false,
        error: "TRACER_INGEST_FAILED",
        message,
      },
      { status: 500 },
    );
  }
}

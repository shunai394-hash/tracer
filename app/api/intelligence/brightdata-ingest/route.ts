import { NextResponse } from "next/server";
import {
  BrightDataConfigError,
  BrightDataRequestError,
  searchGoogleProducts,
} from "@/lib/sources/brightdata/client";
import { persistBrightDataProducts } from "@/lib/tracer/persist-brightdata";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => ({}));
    const query = typeof body?.query === "string" ? body.query.trim() : "women handbag";
    if (!query) return NextResponse.json({ ok: false, error: "query is required" }, { status: 400 });

    const result = await searchGoogleProducts(query);
    const persisted = await persistBrightDataProducts(result.query, result.products);
    return NextResponse.json({
      ok: true,
      query: result.query,
      provider: result.provider,
      fetched: result.products.length,
      persisted,
    });
  } catch (error) {
    console.error("[TRACER INGEST ERROR]", error);
    if (error instanceof BrightDataConfigError) {
      return NextResponse.json({ ok: false, error: error.code, message: error.message }, { status: 500 });
    }
    if (error instanceof BrightDataRequestError) {
      return NextResponse.json({ ok: false, error: error.code, message: error.message }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: "TRACER_INGEST_FAILED", message }, { status: 500 });
  }
}

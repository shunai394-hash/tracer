import { NextResponse } from "next/server";
import { fetchECPulseProduct } from "@/lib/sources/ec-pulse";
import { persistECPulseProduct } from "@/lib/tracer/persist-ec-pulse";

export const dynamic = "force-dynamic";

type ExtensionProduct = {
  source?: string;
  url?: string;
  asin?: string | null;
  title?: string | null;
  brand?: string | null;
  price_text?: string | null;
  image?: string | null;
  captured_at?: string;
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-TRACER-Extension-Key",
    "Access-Control-Max-Age": "86400"
  };
}

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: {
      ...corsHeaders(),
      ...(init?.headers ?? {})
    }
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function validHttpUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("url is required");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must be http(s)");
  }
  return url.toString();
}

export async function POST(request: Request) {
  try {
    const expectedKey = process.env.TRACER_EXTENSION_INGEST_KEY?.trim() || "";
    const suppliedKey = request.headers.get("x-tracer-extension-key")?.trim() || "";
    if (process.env.NODE_ENV === "production" && (!expectedKey || suppliedKey !== expectedKey)) {
      return json({ error: "Extension authentication failed." }, { status: 401 });
    }

    const body = (await request.json()) as ExtensionProduct;
    const url = validHttpUrl(body.url);

    if (!/^https?:\/\/(?:www\.)?amazon\./i.test(url)) {
      return json({ error: "Only Amazon product URLs are supported in this first version." }, { status: 400 });
    }

    const ecPulse = await fetchECPulseProduct(url);
    const persisted = await persistECPulseProduct(ecPulse);

    return json({
      ok: true,
      captured: {
        source: body.source ?? "amazon",
        asin: body.asin ?? null,
        title: body.title ?? null,
        brand: body.brand ?? null,
        price_text: body.price_text ?? null,
        image: body.image ?? null,
        captured_at: body.captured_at ?? new Date().toISOString()
      },
      product: ecPulse,
      persisted,
      ecPulse: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extension product capture failed";
    return json({ ok: false, error: message }, { status: 500 });
  }
}

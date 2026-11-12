import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  buildProductScript,
  nextIntroducibleIndex,
  tiktokReadiness,
  youtubeReadiness,
} from "@/lib/ai-live/program";
import { listSellableAiLiveProducts } from "@/lib/ai-live/sellable-products";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

function present(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

async function authorize(request: Request): Promise<Response | null> {
  if (authorizedAdminToken(request)) return null;
  return requireAutomationAuth(request);
}

function readiness() {
  return {
    ok: true,
    live: false,
    runsOnVercel: false,
    fishAudio: {
      configured: present("FISH_AUDIO_API_KEY"),
      missing: present("FISH_AUDIO_API_KEY") ? [] : ["FISH_AUDIO_API_KEY"],
    },
    youtube: youtubeReadiness({
      clientId: present("YOUTUBE_CLIENT_ID"),
      clientSecret: present("YOUTUBE_CLIENT_SECRET"),
      refreshToken: present("YOUTUBE_REFRESH_TOKEN"),
    }),
    tiktok: tiktokReadiness(present("TIKTOK_RTMP_URL") && present("TIKTOK_STREAM_KEY")),
    workerCommand: "node --experimental-strip-types worker/ai-live-runner.mjs --rehearsal",
  };
}

export async function GET(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  return NextResponse.json(readiness(), {
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function POST(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const input = body as Record<string, unknown>;
  if (input.action !== "script") {
    return NextResponse.json({ ok: false, error: "unsupported_action", readiness: readiness() }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const requested = Number(input.index ?? 0);
  const index = Number.isFinite(requested) ? Math.floor(requested) : 0;
  try {
    const db = createSupabaseAdminClient();
    const products = await listSellableAiLiveProducts(db, 20);
    const chosen = nextIntroducibleIndex(products, index);
    if (chosen === null) {
      return NextResponse.json({ ok: false, error: "no_sellable_product" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const product = products[chosen];
    return NextResponse.json({
      ok: true,
      readOnly: true,
      index: chosen,
      nextIndex: (chosen + 1) % products.length,
      product: {
        id: product.id,
        title: product.title,
        sellingPrice: product.sellingPrice,
        currency: product.currency,
        inStock: product.inStock,
        productUrl: product.productUrl,
        imageUrl: product.imageUrl ?? null,
      },
      script: buildProductScript(product, index),
    }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return NextResponse.json({ ok: false, error: "ai_live_product_read_failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

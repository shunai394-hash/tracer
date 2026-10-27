import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { routeAiLiveComment } from "@/lib/ai-live/comment-router";
import { buildAiLiveReply } from "@/lib/ai-live/reply-from-facts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const MAX_COMMENT_CHARS = 2000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

/**
 * Explicit, authenticated bridge: comment + approved product -> verified reply -> speech.
 * This route is never called automatically by the preview. No order/customer data,
 * external comment ingestion, public posting, retries, or commerce writes.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const apiKey = process.env.FISH_API_KEY;
  const referenceId = process.env.AI_LIVE_FISH_REFERENCE_ID;
  if (!apiKey || !referenceId) {
    return json({
      ok: false,
      error: "verified_speech_not_configured",
      message: "FISH_API_KEY and AI_LIVE_FISH_REFERENCE_ID must be configured server-side. No provider request was sent.",
    }, 503);
  }
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(referenceId)) {
    return json({ ok: false, error: "invalid_server_voice_reference" }, 503);
  }

  let input: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ ok: false, error: "invalid_json_object" }, 400);
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  if (typeof input.comment !== "string" || !input.comment.trim() || input.comment.length > MAX_COMMENT_CHARS) {
    return json({ ok: false, error: "comment_must_be_nonempty_string_under_2001_chars" }, 400);
  }
  if (typeof input.productId !== "string" || !input.productId.trim() || input.productId.length > 128) {
    return json({ ok: false, error: "valid_product_id_required" }, 400);
  }

  const route = routeAiLiveComment(input.comment);
  if (route.action !== "answer_from_verified_facts") {
    return json({
      ok: true,
      readOnly: true,
      spoken: false,
      route,
      reason: "comment_requires_human_or_moderation",
    });
  }

  try {
    const db = createSupabaseAdminClient();
    const { data: row, error } = await db
      .from("shop_listings")
      .select("id,title,description,selling_price,currency,inventory,published,orderable,tracking_available,base_item_id,base_publication_status,archived_at")
      .eq("id", input.productId.trim())
      .eq("published", true)
      .eq("orderable", true)
      .eq("tracking_available", true)
      .gt("inventory", 0)
      .is("archived_at", null)
      .not("base_item_id", "is", null)
      .eq("base_publication_status", "published")
      .maybeSingle();
    if (error) throw new Error("listing_lookup_failed");

    const hasJapaneseText = (value: unknown): value is string =>
      typeof value === "string" && /[\u3040-\u30ff\u3400-\u9fff]/u.test(value);
    const product = row &&
      hasJapaneseText(row.title) &&
      typeof row.selling_price === "number" &&
      Number.isFinite(row.selling_price) &&
      row.selling_price > 0 &&
      typeof row.inventory === "number" &&
      row.inventory > 0
      ? {
          title: row.title.trim(),
          description: hasJapaneseText(row.description) ? row.description.trim() : null,
          sellingPrice: row.selling_price,
          currency: typeof row.currency === "string" && row.currency.trim() ? row.currency : "JPY",
          inStock: true,
          productUrl: `https://tracer.base.ec/items/${encodeURIComponent(String(row.base_item_id))}`,
        }
      : null;

    if (!product) {
      return json({
        ok: true,
        readOnly: true,
        spoken: false,
        route: { category: route.category, action: "human_handoff", reason: "no_verified_sale_ready_product" },
      });
    }

    const reply = buildAiLiveReply(route.category, product);
    if (reply.action !== "speak_verified_reply") {
      return json({
        ok: true,
        readOnly: true,
        spoken: false,
        route: { category: route.category, action: "human_handoff", reason: reply.reason },
      });
    }

    // S2 Pro: a single explicit request causes at most one provider call; never retry automatically.
    const upstream = await fetch(FISH_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        model: "s2-pro",
      },
      body: JSON.stringify({ text: reply.text.slice(0, 1200), reference_id: referenceId, format: "mp3" }),
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });

    if (!upstream.ok) {
      return json({
        ok: false,
        error: "speech_provider_failed",
        message: "Speech generation failed; no automatic retry was attempted.",
      }, 502);
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("audio/")) {
      return json({ ok: false, error: "unexpected_audio_response" }, 502);
    }
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) {
      return json({ ok: false, error: "audio_size_out_of_range" }, 502);
    }
    const audioBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(audioBuffer).set(bytes);
    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(bytes.byteLength),
        'Content-Disposition': 'inline; filename="tracer-ai-live-reply.mp3"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-AI-Voice-Model": "s2-pro",
        "X-AI-Reply-Category": route.category,
      },
    });
  } catch {
    return json({
      ok: false,
      error: "verified_speech_unavailable",
      message: "The listing lookup or speech request failed. No automatic retry was attempted.",
    }, 502);
  }
}

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const API = "https://api.mirelo.ai/v3";
const MODEL = "sfx-2.0";
const MAX_DURATION_SECONDS = 30;

type JsonObject = Record<string, unknown>;

function json(body: JsonObject, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function safePublicVideoUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
        url.hostname.endsWith(".local") || url.hostname === "127.0.0.1" ||
        url.hostname === "::1" || url.hostname.startsWith("10.") ||
        url.hostname.startsWith("192.168.") || url.hostname.startsWith("169.254.")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function mirelo(path: string, key: string, init: RequestInit = {}) {
  return fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
}

async function providerJson(response: Response): Promise<JsonObject> {
  try {
    return asObject(await response.json());
  } catch {
    return {};
  }
}

/**
 * Admin-only, low-cost Mirelo SFX 2.0 integration.
 * Defaults to a non-billable quote. Generation is allowed only when the
 * quote says it is affordable AND the quoted amount fits the actual credit
 * ledger balance (not enabled overage headroom).
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const key = process.env.MIRELO_API_KEY;
  if (!key) return json({
    ok: false,
    error: "mirelo_not_configured",
    message: "Set MIRELO_API_KEY in the server environment. No request was sent to Mirelo.",
  }, 503);

  let input: JsonObject;
  try {
    input = asObject(await request.json());
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const videoUrl = safePublicVideoUrl(input.videoUrl);
  if (!videoUrl) return json({ ok: false, error: "https_public_video_url_required" }, 400);

  const requestedDuration = Number(input.durationSeconds ?? 10);
  if (!Number.isInteger(requestedDuration) || requestedDuration < 1 ||
      requestedDuration > MAX_DURATION_SECONDS) {
    return json({ ok: false, error: "duration_must_be_1_to_30_seconds" }, 400);
  }

  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 2000) : "";
  const negativePrompt = typeof input.negativePrompt === "string"
    ? input.negativePrompt.trim().slice(0, 1000)
    : "";
  const body: JsonObject = {
    model: MODEL,
    duration_ms: requestedDuration * 1000,
    num_variants: 1,
    input: {
      video: { type: "url", url: videoUrl },
      ...(prompt ? { prompt } : {}),
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    },
    controls: { preserve_speech: true },
    output: { media: "video" },
  };

  try {
    const [accountResponse, quoteResponse] = await Promise.all([
      mirelo("/me", key),
      mirelo("/video-to-sfx/generations/preflight", key, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    ]);
    const account = await providerJson(accountResponse);
    const quote = await providerJson(quoteResponse);

    if (!accountResponse.ok || !quoteResponse.ok) {
      const providerError = asObject(quote.error ?? account.error);
      const code = typeof providerError.code === "string" ? providerError.code : "mirelo_preflight_failed";
      return json({ ok: false, error: code, message: "Mirelo could not quote this request. No generation was started." },
        quoteResponse.status >= 400 ? quoteResponse.status : accountResponse.status);
    }

    const recovery = asObject(quote.credit_recovery);
    const creditsRequired = Number(quote.credits ?? recovery.credits_required);
    const creditsAvailable = Number(account.credits_available);
    const provisioningState = String(recovery.provisioning_state ?? account.provisioning_state ?? "unknown");
    const recoveryAction = recovery.recovery_action ?? account.recovery_action ?? null;
    const creditShortfall = Number(recovery.credit_shortfall ?? 0);
    const affordableFromIncludedCredits =
      Number.isFinite(creditsRequired) && creditsRequired >= 0 &&
      Number.isFinite(creditsAvailable) && creditsAvailable >= creditsRequired &&
      provisioningState === "ready" && recoveryAction === null && creditShortfall === 0;

    if (input.action !== "generate") {
      return json({
        ok: true,
        action: "quote",
        model: MODEL,
        durationSeconds: requestedDuration,
        creditsRequired: Number.isFinite(creditsRequired) ? creditsRequired : null,
        creditsAvailable: Number.isFinite(creditsAvailable) ? creditsAvailable : null,
        affordableFromIncludedCredits,
        noCreditsCharged: true,
        generationStarted: false,
      });
    }

    if (!affordableFromIncludedCredits) {
      return json({
        ok: false,
        error: "free_credits_insufficient_or_not_ready",
        model: MODEL,
        creditsRequired: Number.isFinite(creditsRequired) ? creditsRequired : null,
        creditsAvailable: Number.isFinite(creditsAvailable) ? creditsAvailable : null,
        affordableFromIncludedCredits: false,
        generationStarted: false,
        message: "無料残高内で実行できないため停止しました。追加課金・overageには切り替えません。",
      }, 402);
    }

    const idempotencyKey = createHash("sha256")
      .update(`${videoUrl}|sfx-2.0|${requestedDuration}|${prompt}|${negativePrompt}`)
      .digest("hex");

    const createResponse = await mirelo("/video-to-sfx/generations?wait=20", key, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    });
    const job = await providerJson(createResponse);
    if (!createResponse.ok) {
      const providerError = asObject(job.error);
      return json({
        ok: false,
        error: typeof providerError.code === "string" ? providerError.code : "mirelo_generation_failed",
        message: "Mirelo generation did not complete successfully.",
        generationStarted: false,
      }, createResponse.status);
    }

    const urls = asObject(job.urls);
    const result = asObject(job.result);
    const outputs = Array.isArray(result.outputs) ? result.outputs : [];
    const firstOutput = asObject(outputs[0]);
    const outputUrl = typeof firstOutput.url === "string" ? firstOutput.url : null;

    return json({
      ok: true,
      action: "generate",
      model: MODEL,
      jobId: typeof job.id === "string" ? job.id : null,
      status: typeof job.status === "string" ? job.status : "unknown",
      creditsCharged: Number(job.credits) || creditsRequired,
      resultUrl: outputUrl,
      jobUrl: typeof urls.self === "string" ? urls.self : null,
      generationStarted: true,
      note: "Output download URLs expire; retrieve the job again before downloading if needed.",
    }, createResponse.status === 202 ? 202 : 200);
  } catch {
    return json({
      ok: false,
      error: "mirelo_unavailable",
      message: "Mirelo request failed or timed out. Check the job in Mirelo before retrying.",
    }, 502);
  }
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const key = process.env.MIRELO_API_KEY;
  if (!key) return json({ ok: false, error: "mirelo_not_configured" }, 503);

  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId || !/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) {
    return json({ ok: false, error: "valid_job_id_required" }, 400);
  }

  try {
    const response = await mirelo(`/video-to-sfx/generations/${encodeURIComponent(jobId)}?wait=20`, key);
    const job = await providerJson(response);
    if (!response.ok) {
      const providerError = asObject(job.error);
      return json({
        ok: false,
        error: typeof providerError.code === "string" ? providerError.code : "mirelo_job_lookup_failed",
      }, response.status);
    }

    const urls = asObject(job.urls);
    const result = asObject(job.result);
    const outputs = Array.isArray(result.outputs) ? result.outputs : [];
    const firstOutput = asObject(outputs[0]);

    return json({
      ok: true,
      jobId,
      status: typeof job.status === "string" ? job.status : "unknown",
      creditsCharged: Number(job.credits) || 0,
      resultUrl: typeof firstOutput.url === "string" ? firstOutput.url : null,
      jobUrl: typeof urls.self === "string" ? urls.self : null,
    });
  } catch {
    return json({ ok: false, error: "mirelo_unavailable" }, 502);
  }
}

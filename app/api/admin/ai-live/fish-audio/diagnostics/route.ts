import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { TRACER_DRAMA_CHARACTER_VOICES, resolveFishAudioModelVoice } from "@/lib/ai-live/fish-audio-drama-character-voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BASE = "https://api.fish.audio";
const TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_MODEL_PAGES = 10;

function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.slice(0, 7).toLowerCase() === "bearer " ? authorization.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function fishGet(path: string, apiKey: string): Promise<unknown> {
  const response = await fetch(new URL(path, BASE), {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await response.text();
  let body: unknown = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { message: "non_json_provider_response" }; }
  if (!response.ok) {
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    throw Object.assign(new Error(String(record.message ?? record.detail ?? record.error ?? "Fish Audio request failed")), {
      providerStatus: response.status,
    });
  }
  return body;
}

async function listOwnedModels(apiKey: string): Promise<{ items: unknown[]; total: number | null; pagesScanned: number }> {
  const first = await fishGet(`/model?self=true&page_size=${PAGE_SIZE}&page_number=1&sort_by=created_at`, apiKey);
  if (!first || typeof first !== "object" || !Array.isArray((first as Record<string, unknown>).items)) {
    throw new Error("Fish Audio returned an invalid model list.");
  }
  const firstPage = first as { items: unknown[]; total?: unknown };
  const total = typeof firstPage.total === "number" && Number.isFinite(firstPage.total) ? Math.max(0, firstPage.total) : null;
  const pages = total === null ? 1 : Math.min(MAX_MODEL_PAGES, Math.max(1, Math.ceil(total / PAGE_SIZE)));
  const remaining = await Promise.all(Array.from({ length: pages - 1 }, (_, index) =>
    fishGet(`/model?self=true&page_size=${PAGE_SIZE}&page_number=${index + 2}&sort_by=created_at`, apiKey)
  ));
  const items = [...firstPage.items];
  for (const page of remaining) {
    if (page && typeof page === "object" && Array.isArray((page as Record<string, unknown>).items)) {
      items.push(...((page as { items: unknown[] }).items));
    }
  }
  return { items, total, pagesScanned: pages };
}

function safeError(error: unknown) {
  const value = error as { message?: unknown; providerStatus?: unknown };
  return {
    ok: false,
    status: typeof value.providerStatus === "number" ? value.providerStatus : null,
    error: typeof value.message === "string" ? value.message.slice(0, 240) : "provider_request_failed",
  };
}

/** Read-only diagnostics for the Fish Audio API key configured in this deployment. */
export async function GET(request: Request) {
  if (!authorizedAdminToken(request)) {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;
  }

  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) return json({ ok: false, error: "fish_audio_not_configured" }, 503);

  const [creditResult, packageResult, modelsResult] = await Promise.allSettled([
    fishGet("/wallet/self/api-credit?check_free_credit=true", apiKey),
    fishGet("/wallet/self/package", apiKey),
    listOwnedModels(apiKey),
  ]);

  const credit = creditResult.status === "fulfilled" && creditResult.value && typeof creditResult.value === "object"
    ? creditResult.value as Record<string, unknown>
    : null;
  const subscription = packageResult.status === "fulfilled" && packageResult.value && typeof packageResult.value === "object"
    ? packageResult.value as Record<string, unknown>
    : null;
  const owned = modelsResult.status === "fulfilled" ? modelsResult.value : null;
  const ownModels = (owned?.items ?? []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const model = item as Record<string, unknown>;
    const id = typeof model._id === "string" ? model._id : "";
    const title = typeof model.title === "string" ? model.title : "";
    if (!id || !title) return [];
    return [{
      id,
      title: title.slice(0, 100),
      type: typeof model.type === "string" ? model.type : null,
      visibility: typeof model.visibility === "string" ? model.visibility : null,
      createdAt: typeof model.created_at === "string" ? model.created_at : null,
      tags: Array.isArray(model.tags) ? model.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 8) : [],
    }];
  });
  const targetModels = ownModels.filter((model) => /蒼真|soma|tracer-drama-clone/i.test(model.title + " " + model.tags.join(" ")));

  const assignedCharacterVoices = await Promise.all(TRACER_DRAMA_CHARACTER_VOICES.map(async (character) => {
    try {
      const [voice, detailResult] = await Promise.allSettled([
        resolveFishAudioModelVoice(apiKey, character.id, character.title),
        fishGet(`/model/${encodeURIComponent(character.id)}`, apiKey),
      ]);
      const detail = detailResult.status === "fulfilled" && detailResult.value && typeof detailResult.value === "object"
        ? detailResult.value as Record<string, unknown>
        : null;
      const samples = Array.isArray(detail?.samples) ? detail.samples.slice(0, 5).flatMap((sample) => {
        if (!sample || typeof sample !== "object") return [];
        const item = sample as Record<string, unknown>;
        const audio = typeof item.audio === "string" && /^https:\/\//i.test(item.audio) ? item.audio : null;
        return [{
          title: typeof item.title === "string" ? item.title.slice(0, 120) : null,
          text: typeof item.text === "string" ? item.text.slice(0, 300) : null,
          audio,
        }];
      }) : [];
      return {
        title: character.title,
        id: character.id,
        accessible: voice.status === "fulfilled" && Boolean(voice.value),
        status: voice.status === "fulfilled" && voice.value ? "accessible" : "not_accessible",
        providerDetailStatus: detailResult.status === "fulfilled" ? "available" : "lookup_failed",
        provider: detail ? {
          title: typeof detail.title === "string" ? detail.title.slice(0, 120) : null,
          type: typeof detail.type === "string" ? detail.type : null,
          state: typeof detail.state === "string" ? detail.state : null,
          description: typeof detail.description === "string" ? detail.description.slice(0, 500) : null,
          languages: Array.isArray(detail.languages) ? detail.languages.filter((v): v is string => typeof v === "string").slice(0, 12) : [],
          tags: Array.isArray(detail.tags) ? detail.tags.filter((v): v is string => typeof v === "string").slice(0, 20) : [],
          updatedAt: typeof detail.updated_at === "string" ? detail.updated_at : null,
          samples,
        } : null,
      };
    } catch {
      return { title: character.title, id: character.id, accessible: false, status: "lookup_failed", providerDetailStatus: "lookup_failed", provider: null };
    }
  }));

  const checks = {
    apiCredit: creditResult.status === "fulfilled"
      ? { ok: true, balance: typeof credit?.credit === "string" || typeof credit?.credit === "number" ? String(credit.credit) : null, hasFreeCredit: typeof credit?.has_free_credit === "boolean" ? credit.has_free_credit : null }
      : safeError(creditResult.reason),
    membershipPackage: packageResult.status === "fulfilled"
      ? { ok: true, type: typeof subscription?.type === "string" ? subscription.type : null, balance: typeof subscription?.balance === "number" ? subscription.balance : null, total: typeof subscription?.total === "number" ? subscription.total : null }
      : safeError(packageResult.reason),
    modelLibrary: modelsResult.status === "fulfilled"
      ? { ok: true, scannedCount: ownModels.length, total: owned?.total, pagesScanned: owned?.pagesScanned, truncated: owned?.total !== null && (owned?.total ?? 0) > ownModels.length, matchingSomaCount: targetModels.length, matchingSoma: targetModels }
      : safeError(modelsResult.reason),
  };

  const allReadable = checks.apiCredit.ok && checks.membershipPackage.ok && checks.modelLibrary.ok;
  return json({
    ok: true,
    readOnly: true,
    checkedAt: new Date().toISOString(),
    account: checks,
    assignedCharacterVoices,
    interpretation: allReadable
      ? "Fish Audio account, API credit, membership package, and owned voice models were read. The model-creation quota itself is not exposed by these read endpoints; if the API balance is positive and 蒼真 is absent, ask Fish Audio support to inspect the API key's model-creation entitlement before paying."
      : "One or more read-only checks failed. Review each provider status; do not retry voice uploads until the API key account and API credit are confirmed.",
  });
}

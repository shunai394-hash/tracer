import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BASE = "https://api.fish.audio";
const TIMEOUT_MS = 12_000;

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

async function fishGet(path: string, apiKey: string): Promise<{ status: number; body: unknown }> {
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
  return { status: response.status, body };
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
    fishGet("/model?self=true&page_size=100&page_number=1&sort_by=created_at", apiKey),
  ]);

  const credit = creditResult.status === "fulfilled" && creditResult.value.body && typeof creditResult.value.body === "object"
    ? creditResult.value.body as Record<string, unknown>
    : null;
  const subscription = packageResult.status === "fulfilled" && packageResult.value.body && typeof packageResult.value.body === "object"
    ? packageResult.value.body as Record<string, unknown>
    : null;
  const modelPayload = modelsResult.status === "fulfilled" && modelsResult.value.body && typeof modelsResult.value.body === "object"
    ? modelsResult.value.body as Record<string, unknown>
    : null;
  const modelItems = modelPayload && Array.isArray(modelPayload.items) ? modelPayload.items : [];
  const ownModels = modelItems.flatMap((item) => {
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

  const checks = {
    apiCredit: creditResult.status === "fulfilled"
      ? { ok: true, balance: typeof credit?.credit === "string" || typeof credit?.credit === "number" ? String(credit.credit) : null, hasFreeCredit: typeof credit?.has_free_credit === "boolean" ? credit.has_free_credit : null }
      : safeError(creditResult.reason),
    membershipPackage: packageResult.status === "fulfilled"
      ? { ok: true, type: typeof subscription?.type === "string" ? subscription.type : null, balance: typeof subscription?.balance === "number" ? subscription.balance : null, total: typeof subscription?.total === "number" ? subscription.total : null }
      : safeError(packageResult.reason),
    modelLibrary: modelsResult.status === "fulfilled"
      ? { ok: true, pageCount: ownModels.length, total: typeof modelPayload?.total === "number" ? modelPayload.total : null, matchingSomaCount: targetModels.length, matchingSoma: targetModels }
      : safeError(modelsResult.reason),
  };

  const allReadable = checks.apiCredit.ok && checks.membershipPackage.ok && checks.modelLibrary.ok;
  return json({
    ok: true,
    readOnly: true,
    checkedAt: new Date().toISOString(),
    account: checks,
    interpretation: allReadable
      ? "Fish Audio account, API credit, membership package, and first page of owned models were read. A 0/0 model-creation quota is not exposed by these read endpoints; if the balance is positive and no 蒼真 model exists, request Fish Audio to inspect the account's model-creation entitlement before paying."
      : "One or more read-only checks failed. Review each provider status; do not retry voice uploads until the account identity and API credit are confirmed.",
  });
}

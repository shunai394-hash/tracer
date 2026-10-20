import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { editBaseItem, fetchBaseItemsSnapshot, getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";
import { generateStructuredJson, isGeminiConfigured } from "@/lib/ai/gemini/client";
import { isJapaneseProductDescription, isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";

export const runtime = "nodejs";
export const maxDuration = 300;

type JapaneseCopy = { title: string; detail: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function hasUsableJapaneseCopy(value: string): boolean {
  if (!/[ぁ-んァ-ヶ一-龯々〆ヵー]/.test(value)) return false;
  const japanese = (value.match(/[ぁ-んァ-ヶ一-龯々〆ヵー]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  return latin <= Math.max(12, japanese * 1.5);
}

function visibleOf(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function needsJapaneseCopy(title: string, detail: string): boolean {
  return !isJapaneseProductTitle(title) || !hasUsableJapaneseCopy(title) ||
    !isJapaneseProductDescription(detail) || !hasUsableJapaneseCopy(detail);
}

async function translate(title: string, detail: string): Promise<JapaneseCopy> {
  const result = await generateStructuredJson<JapaneseCopy>({
    systemInstruction: "あなたは日本のEC商品編集者兼SEO担当です。商品名は、商品種別・ブランド・型番など入力にある重要語を自然な日本語で前方に置き、検索結果で内容がすぐ伝わる簡潔な表現にしてください。説明文は日本語で、入力に明記された用途・特徴・素材・サイズ等だけを整理し、購入者が検索しそうな関連語を不自然にならない範囲で含めてください。キーワードの羅列、誇大表現、根拠のない最上級は禁止です。ブランド名・型番など必要な固有名詞のみ原文を残してください。入力にない素材、サイズ、機能、性能、認証、保証、配送条件を絶対に創作しないでください。商品名と説明の両方を日本語にし、JSONのみ返してください.",
    prompt: JSON.stringify({ title, detail }),
    timeoutMs: 12_000,
  });
  const translatedTitle = text(result?.title);
  const translatedDetail = text(result?.detail);
  if (!isJapaneseProductTitle(translatedTitle) || !hasUsableJapaneseCopy(translatedTitle)) {
    throw new Error("translated_title_not_japanese");
  }
  if (!isJapaneseProductDescription(translatedDetail) || !hasUsableJapaneseCopy(translatedDetail)) {
    throw new Error("translated_description_not_japanese");
  }
  return { title: translatedTitle, detail: translatedDetail };
}

/**
 * Walk the actual BASE catalog and repair English-heavy copy in bounded batches.
 * Price, stock, visibility and identifier are read before the edit and verified
 * from BASE after the edit. This route never publishes, unpublishes, or changes stock.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, { status: 503 });
  }
  if (!isGeminiConfigured()) {
    return NextResponse.json({ ok: false, error: "GEMINI_API_KEY_REQUIRED" }, { status: 503 });
  }

  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 50))));
  let snapshot;
  try {
    snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: 50 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 240) : "BASE_SNAPSHOT_FAILED",
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  if (!snapshot.complete) {
    return NextResponse.json({ ok: false, error: "BASE_SNAPSHOT_INCOMPLETE", pages: snapshot.pages }, { status: 502 });
  }

  // Always scan the complete snapshot, then rotate the bounded batch. Without
  // rotation, the same first 50 failed translations can starve every later item.
  const candidatePool = snapshot.items
    .filter((item) => /^\d+$/.test(text(item.item_id)))
    .filter((item) => needsJapaneseCopy(text(item.title), text(item.detail)))
    .sort((a, b) => Number(text(a.item_id)) - Number(text(b.item_id)));
  const requestedOffset = url.searchParams.get("offset");
  const rotationOffset = requestedOffset !== null && /^\d+$/.test(requestedOffset)
    ? Number(requestedOffset) % Math.max(1, candidatePool.length)
    : (Math.floor(Date.now() / (15 * 60 * 1000)) * limit) % Math.max(1, candidatePool.length);
  const candidates = candidatePool.length <= limit
    ? candidatePool
    : Array.from({ length: limit }, (_, index) => candidatePool[(rotationOffset + index) % candidatePool.length]);

  console.log("[TRACER BASE JAPANESE COPY] batch_start", JSON.stringify({
    snapshotItems: snapshot.items.length,
    candidatePool: candidatePool.length,
    limit,
    rotationOffset,
  }));

  let nextIndex = 0;
  const results: Array<Record<string, unknown>> = [];
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      const itemId = text(candidates[index].item_id);
      try {
        const before = await getBaseItemDetail(itemId);
        const originalTitle = text(before.title);
        const originalDetail = text(before.detail);
        const price = numberValue(before.price);
        const stock = numberValue(before.stock);
        const visible = visibleOf(before.visible);
        const identifier = text(before.identifier);
        if (!originalTitle || !originalDetail || price === null || price <= 0 ||
            stock === null || stock < 0 || visible === null) {
          results.push({ itemId, outcome: "skipped_live_item_state_incomplete" });
          continue;
        }
        if (!needsJapaneseCopy(originalTitle, originalDetail)) {
          results.push({ itemId, outcome: "already_japanese_on_readback" });
          continue;
        }
        const copy = await translate(originalTitle, originalDetail);
        await editBaseItem({ itemId, title: copy.title, detail: copy.detail, price, stock, visible });
        const after = await getBaseItemDetail(itemId);
        const verified =
          text(after.title) === copy.title &&
          text(after.detail) === copy.detail &&
          numberValue(after.price) === price &&
          numberValue(after.stock) === stock &&
          visibleOf(after.visible) === visible &&
          text(after.identifier) === identifier &&
          !needsJapaneseCopy(text(after.title), text(after.detail));
        results.push({
          itemId,
          outcome: verified ? "translated_and_verified" : "readback_mismatch",
          pricePreserved: numberValue(after.price) === price,
          stockPreserved: numberValue(after.stock) === stock,
          visibilityPreserved: visibleOf(after.visible) === visible,
          identifierPreserved: text(after.identifier) === identifier,
          titleJapanese: hasUsableJapaneseCopy(text(after.title)),
          descriptionJapanese: hasUsableJapaneseCopy(text(after.detail)),
        });
      } catch (error) {
        results.push({
          itemId,
          outcome: "failed",
          error: error instanceof Error ? error.message.slice(0, 180) : "unknown_error",
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, candidates.length) }, () => worker()));
  const translated = results.filter((item) => item.outcome === "translated_and_verified").length;
  const failed = results.filter((item) => !["translated_and_verified", "already_japanese_on_readback"].includes(String(item.outcome))).length;
  const response = {
    ok: failed === 0,
    phase: "base_japanese_copy_repair",
    snapshotItems: snapshot.items.length,
    pages: snapshot.pages,
    candidatePool: candidatePool.length,
    rotationOffset,
    requested: candidates.length,
    translatedAndVerified: translated,
    failed,
    remainingEnglishEstimate: Math.max(0, snapshot.items.filter((item) => /^\d+$/.test(text(item.item_id)) && needsJapaneseCopy(text(item.title), text(item.detail))).length - translated),
    results,
  };
  console.log("[TRACER BASE JAPANESE COPY] batch_complete", JSON.stringify({
    ok: response.ok,
    snapshotItems: response.snapshotItems,
    candidatePool: response.candidatePool,
    rotationOffset: response.rotationOffset,
    requested: response.requested,
    translatedAndVerified: response.translatedAndVerified,
    failed: response.failed,
    remainingEnglishEstimate: response.remainingEnglishEstimate,
  }));
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}

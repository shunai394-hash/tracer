import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { editBaseItem, getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";
import { generateStructuredJson, isGeminiConfigured } from "@/lib/ai/gemini/client";
import { isJapaneseProductDescription, isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { deterministicJapaneseCopy } from "@/lib/channels/base/japanese-copy-fallback";

export const runtime = "nodejs";
export const maxDuration = 120;

type JapaneseCopy = { title: string; detail: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function hasJapaneseCopy(value: string): boolean {
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

async function translate(title: string, detail: string): Promise<JapaneseCopy> {
  const request = {
    systemInstruction: "あなたは日本のEC商品編集者です。英語の商品名と説明を自然な日本語の販売用コピーにしてください。商品名は簡潔な日本語、説明は読みやすい日本語にします。ブランド名、型番、色名など必要な固有名詞だけ原文を残してください。入力にない機能・素材・サイズ・性能・認証・保証・配送条件を創作しないでください。商品名と説明の両方を日本語にし、JSONのみ返してください。",
    prompt: JSON.stringify({ title, detail }),
    timeoutMs: 12_000,
  } as const;

  let result: JapaneseCopy | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      result = await generateStructuredJson<JapaneseCopy>(request);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const isTemporaryCapacityError =
        /HTTP 503\s+UNAVAILABLE|HTTP 429\s+RESOURCE_EXHAUSTED/i.test(message);
      if (!isTemporaryCapacityError) throw error;
      if (attempt === 1) {
        // Gemini quota/capacity can remain exhausted after retry. Use only the
        // repository's deterministic source-title mappings; never invent specs.
        const fallback = deterministicJapaneseCopy(title, detail);
        if (fallback) return fallback;
        throw error;
      }
      // Retry only explicit capacity/rate-limit responses; do not repeat unrelated
      // failures that could consume the route's execution budget.
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  const translatedTitle = text(result?.title);
  const translatedDetail = text(result?.detail);
  if (!isJapaneseProductTitle(translatedTitle) || !hasJapaneseCopy(translatedTitle)) {
    throw new Error("translated_title_not_japanese");
  }
  if (!isJapaneseProductDescription(translatedDetail)) {
    throw new Error("translated_detail_not_japanese");
  }
  return { title: translatedTitle, detail: translatedDetail };
}

/**
 * Repair Japanese copy for explicitly supplied BASE item IDs.
 * Defaults to read-only preview; apply=true edits only title/detail and verifies
 * the live item afterward. Price, stock, SKU and visibility are preserved.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, { status: 503 });
  }
  if (!isGeminiConfigured()) {
    return NextResponse.json({ ok: false, error: "GEMINI_API_KEY_REQUIRED" }, { status: 503 });
  }

  let body: { itemIds?: unknown; apply?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const rawIds = Array.isArray(body.itemIds) ? body.itemIds : [];
  const itemIds = [...new Set(rawIds.map((value) => String(value ?? "").trim()))];
  if (itemIds.length < 1 || itemIds.length > 10 || itemIds.some((id) => !/^\d+$/.test(id))) {
    return NextResponse.json({ ok: false, error: "itemIds_must_contain_1_to_10_numeric_BASE_item_ids" }, { status: 400 });
  }
  const apply = body.apply === true;
  const results: Array<Record<string, unknown>> = [];

  for (const itemId of itemIds) {
    try {
      const before = await getBaseItemDetail(itemId);
      const title = text(before.title);
      const detail = text(before.detail);
      const price = numberValue(before.price);
      const stock = numberValue(before.stock);
      const visible = visibleOf(before.visible);
      const identifier = text(before.identifier);
      if (!title || detail === "" || price === null || price <= 0 || stock === null || stock < 0 || visible === null) {
        results.push({ itemId, outcome: "skipped_live_item_state_incomplete" });
        continue;
      }
      if (isJapaneseProductTitle(title) && hasJapaneseCopy(title) && hasJapaneseCopy(detail)) {
        results.push({ itemId, outcome: "already_japanese", title });
        continue;
      }
      const copy = await translate(title, detail);
      if (!apply) {
        results.push({ itemId, outcome: "preview", originalTitle: title, japaneseTitle: copy.title, japaneseDetail: copy.detail });
        continue;
      }

      await editBaseItem({ itemId, title: copy.title, detail: copy.detail, price, stock, visible });
      const after = await getBaseItemDetail(itemId);
      const afterPrice = numberValue(after.price);
      const afterStock = numberValue(after.stock);
      const afterVisible = visibleOf(after.visible);
      const afterIdentifier = text(after.identifier);
      const verified =
        text(after.title) === copy.title &&
        text(after.detail) === copy.detail &&
        afterPrice === price &&
        afterStock === stock &&
        afterVisible === visible &&
        afterIdentifier === identifier;
      results.push({
        itemId,
        outcome: verified ? "translated_and_verified" : "readback_mismatch",
        originalTitle: title,
        japaneseTitle: text(after.title),
        pricePreserved: afterPrice === price,
        stockPreserved: afterStock === stock,
        visibilityPreserved: afterVisible === visible,
        skuPreserved: afterIdentifier === identifier,
        titleJapanese: hasJapaneseCopy(text(after.title)),
        detailJapanese: hasJapaneseCopy(text(after.detail)),
      });
    } catch (error) {
      results.push({
        itemId,
        outcome: "failed",
        error: error instanceof Error ? error.message.slice(0, 180) : "unknown_error",
      });
    }
  }

  return NextResponse.json({
    ok: results.every((row) => ["preview", "already_japanese", "translated_and_verified"].includes(String(row.outcome))),
    apply,
    readOnly: !apply,
    requested: itemIds.length,
    translatedAndVerified: results.filter((row) => row.outcome === "translated_and_verified").length,
    previews: results.filter((row) => row.outcome === "preview").length,
    failedOrMismatched: results.filter((row) => ["failed", "readback_mismatch", "skipped_live_item_state_incomplete"].includes(String(row.outcome))).length,
    results,
  }, { headers: { "Cache-Control": "no-store" } });
}

import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { editBaseItem, fetchBaseItemsSnapshot, getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";
import { generateStructuredJson, isGeminiConfigured } from "@/lib/ai/gemini/client";
import { isJapaneseProductDescription, isJapaneseProductTitle, isSpecificJapaneseProductTitle, localizeProductDescription, localizeProductTitle } from "@/lib/intelligence/japanese-product";

export const runtime = "nodejs";
export const maxDuration = 300;

type JapaneseCopy = { title: string; detail: string };

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function numberValue(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function hasUsableJapaneseCopy(value: string, kind: "title" | "detail" = "detail"): boolean {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || !/[ぁ-んァ-ヶ一-龯々〆ヵー]/.test(normalized)) return false;
  const japanese = (normalized.match(/[ぁ-んァ-ヶ一-龯々〆ヵー]/g) ?? []).length;
  const latin = (normalized.match(/[A-Za-z]/g) ?? []).length;
  const latinWords = (normalized.match(/[A-Za-z]{3,}/g) ?? []).length;
  if (kind === "title") {
    return japanese >= 2 && latinWords <= 3 && latin <= Math.max(8, japanese * 0.6);
  }
  return japanese >= 12 && latinWords <= Math.max(4, Math.floor(japanese / 18)) &&
    latin <= Math.max(10, japanese * 0.35);
}

function visibleOf(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function needsJapaneseCopy(title: string, detail: string): boolean {
  return !isJapaneseProductTitle(title) || !hasUsableJapaneseCopy(title, "title") ||
    !isJapaneseProductDescription(detail) || !hasUsableJapaneseCopy(detail, "detail");
}

async function translate(title: string, detail: string): Promise<JapaneseCopy> {
  const result = await generateStructuredJson<JapaneseCopy>({
    systemInstruction: "あなたは日本のEC商品編集者兼SEO担当です。商品名は、商品種別・ブランド・型番など入力にある重要語を自然な日本語で前方に置き、検索結果で内容がすぐ伝わる簡潔な表現にしてください。説明文は日本語で、入力に明記された用途・特徴・素材・サイズ等だけを整理し、購入者が検索しそうな関連語を不自然にならない範囲で含めてください。キーワードの羅列、誇大表現、根拠のない最上級は禁止です。ブランド名・型番など必要な固有名詞のみ原文を残してください。入力にない素材、サイズ、機能、性能、認証、保証、配送条件を絶対に創作しないでください。商品名と説明の両方を日本語にし、JSONのみ返してください.",
    prompt: JSON.stringify({ title, detail }),
    timeoutMs: 25_000,
  });
  const translatedTitle = text(result?.title);
  const translatedDetail = text(result?.detail);
  if (!isJapaneseProductTitle(translatedTitle) || !hasUsableJapaneseCopy(translatedTitle, "title")) {
    throw new Error("translated_title_not_japanese");
  }
  if (!isJapaneseProductDescription(translatedDetail) || !hasUsableJapaneseCopy(translatedDetail, "detail")) {
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
  const url = new URL(request.url);
  const limit = Math.min(10, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 10))));
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
  const requestedItemId = text(url.searchParams.get("itemId"));
  const afterItemId = text(url.searchParams.get("afterItemId"));
  let candidatePool = snapshot.items
    .filter((item) => /^\d+$/.test(text(item.item_id)))
    .filter((item) => !afterItemId || Number(text(item.item_id)) > Number(afterItemId))
    .filter((item) => requestedItemId
      ? text(item.item_id) === requestedItemId
      : needsJapaneseCopy(text(item.title), text(item.detail)))
    .sort((a, b) => {
      // Cursor-based bulk runs use stable numeric order so failures cannot starve later IDs.
      if (afterItemId) return Number(text(a.item_id)) - Number(text(b.item_id));
      // Run source-grounded deterministic mappings before Gemini-dependent items.
      // A quota failure must not starve listings that can be safely localized offline.
      const priority = (item: (typeof snapshot.items)[number]) => {
        const itemId = text(item.item_id);
        if (["160447301", "160447305", "160447306", "160447308", "160454016"].includes(itemId)) return 0;
        const title = localizeProductTitle(text(item.title));
        const detail = localizeProductDescription(text(item.title));
        if (
          isSpecificJapaneseProductTitle(title) &&
          typeof detail === "string" &&
          isJapaneseProductDescription(detail) &&
          hasUsableJapaneseCopy(detail, "detail")
        ) return 1;
        return 2;
      };
      return priority(a) - priority(b) || Number(text(a.item_id)) - Number(text(b.item_id));
    });
  // A published legacy BASE URL may remain valid even when its item is absent
  // from the paginated catalog. For an explicitly requested ID, probe that exact
  // item detail endpoint before declaring it missing; the worker still performs
  // its own live read and verifies price, stock, visibility, identifier, and copy.
  if (requestedItemId && candidatePool.length === 0) {
    try {
      const directItem = await getBaseItemDetail(requestedItemId);
      if (text(directItem.item_id) !== requestedItemId) {
        throw new Error("BASE_ITEM_DETAIL_ID_MISMATCH");
      }
      candidatePool = [directItem];
    } catch (error) {
      return NextResponse.json({
        ok: false,
        error: "BASE_ITEM_ID_NOT_FOUND_IN_SNAPSHOT_OR_DETAIL",
        itemId: requestedItemId,
        snapshotItems: snapshot.items.length,
        detailError: error instanceof Error ? error.message.slice(0, 180) : "BASE_ITEM_DETAIL_FAILED",
      }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
  }
  // If the catalog detector returns an empty pool, probe a known public English
  // listing directly. This prevents a false "0 remaining" result from hiding a
  // catalog/API mismatch and lets the normal verified repair worker fix it.
  let emptyPoolProbe: Record<string, unknown> | null = null;
  if (!requestedItemId && !afterItemId && candidatePool.length === 0) {
    const probeItemId = "160447301";
    try {
      const probe = await getBaseItemDetail(probeItemId);
      if (text(probe.item_id) !== probeItemId) {
        throw new Error("BASE_ITEM_DETAIL_ID_MISMATCH");
      }
      const probeNeedsJapaneseCopy = needsJapaneseCopy(text(probe.title), text(probe.detail));
      emptyPoolProbe = {
        itemId: probeItemId,
        found: true,
        needsJapaneseCopy: probeNeedsJapaneseCopy,
        liveTitlePreview: text(probe.title).slice(0, 120),
      };
      if (probeNeedsJapaneseCopy) candidatePool = [probe];
    } catch (error) {
      emptyPoolProbe = {
        itemId: probeItemId,
        found: false,
        error: error instanceof Error ? error.message.slice(0, 180) : "BASE_ITEM_DETAIL_FAILED",
      };
    }
  }

  const requestedOffset = url.searchParams.get("offset");
  const rotationOffset = requestedOffset !== null && /^\d+$/.test(requestedOffset)
    ? Number(requestedOffset) % Math.max(1, candidatePool.length)
    : (Math.floor(Date.now() / (15 * 60 * 1000)) * limit) % Math.max(1, candidatePool.length);
  // Do not apply rotation to deterministic candidates: doing so can skip all
  // offline-safe repairs and immediately hit Gemini's exhausted quota again.
  const offlineCandidates = requestedItemId ? [] : candidatePool.filter((item) => {
    const itemId = text(item.item_id);
    if (["160447301", "160447305", "160447306", "160447308", "160454016"].includes(itemId)) return true;
    const localizedTitle = localizeProductTitle(text(item.title));
    const localizedDetail = localizeProductDescription(text(item.title));
    return isSpecificJapaneseProductTitle(localizedTitle) &&
      typeof localizedDetail === "string" &&
      isJapaneseProductDescription(localizedDetail) &&
      hasUsableJapaneseCopy(localizedDetail, "detail");
  });
  // Fill the batch with remaining catalog candidates when the deterministic
  // subset is smaller than the requested limit. A stale snapshot item can read
  // back as already Japanese; it must not make the entire bulk run stop after
  // checking just that one item.
  const deterministicIds = new Set(offlineCandidates.map((item) => text(item.item_id)));
  const orderedCandidates = requestedItemId || afterItemId
    ? candidatePool
    : [
        ...offlineCandidates,
        ...candidatePool.filter((item) => !deterministicIds.has(text(item.item_id))),
      ];
  const candidates = requestedItemId
    ? orderedCandidates.slice(0, 1)
    : afterItemId
      ? orderedCandidates.slice(0, limit)
      : orderedCandidates.slice(rotationOffset, rotationOffset + limit);

  console.log("[TRACER BASE JAPANESE COPY] batch_start", JSON.stringify({
    snapshotItems: snapshot.items.length,
    candidatePool: candidatePool.length,
    limit,
    rotationOffset,
    emptyPoolProbe,
  }));

  let nextIndex = 0;
  let providerUnavailable = false;
  const results: Array<Record<string, unknown>> = [];
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      const itemId = text(candidates[index].item_id);
      // After Gemini quota failure, do not call Gemini for later AI-only items.
      // Keep processing offline-safe candidates and record the rest as deferred.
      if (providerUnavailable && !requestedItemId) {
        const candidate = candidates[index];
        const candidateId = text(candidate.item_id);
        const candidateTitle = localizeProductTitle(text(candidate.title));
        const candidateDetail = localizeProductDescription(text(candidate.title));
        const offlineSafe = isSpecificJapaneseProductTitle(candidateTitle) &&
          typeof candidateDetail === "string" &&
          isJapaneseProductDescription(candidateDetail) &&
          hasUsableJapaneseCopy(candidateDetail, "detail");
        if (!offlineSafe && !["160447301", "160447305", "160447306", "160447308", "160454016"].includes(candidateId)) {
          results.push({ itemId, outcome: "deferred_ai_provider_unavailable", reason: "Gemini quota/capacity unavailable; item left unchanged" });
          continue;
        }
      }
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
        // Use deterministic, source-grounded Japanese copy for the explicitly
        // reported legacy item. This avoids repeated Gemini failures for the
        // same listing; all other catalog items continue through translation.
        const deterministicTitle = localizeProductTitle(originalTitle);
        const deterministicDetail = localizeProductDescription(originalTitle);
        const deterministicCopyIsSafe =
          isSpecificJapaneseProductTitle(deterministicTitle) &&
          typeof deterministicDetail === "string" &&
          isJapaneseProductDescription(deterministicDetail) &&
          hasUsableJapaneseCopy(deterministicDetail, "detail");
        const fixedCopyByItemId: Record<string, JapaneseCopy> = {
          "160447301": {
            title: "水槽用ミニサンゴ風オーナメント No.9（ホワイト）",
            detail: "水槽のレイアウトに使える、ホワイトカラーのミニサンゴ風オーナメントです。商品名に記載されたNo.9のデザインです。素材や水中での使用可否など、商品ページに明記されていない仕様は購入前にご確認ください。",
          },
          "160447305": {
            title: "木製ルーレットホイール イエロー 45cm／50cm（アメリカン式 0・00）",
            detail: "イエローカラーの木製ルーレットホイールです。仕入先の商品名には直径45cm（18インチ）または50cm（20インチ）の表記があり、対象バリエーションは「45cm・アメリカン式 0・00」と記載されています。サイズやルーレット形式は、ご注文前に選択中のバリエーションと商品画像をご確認ください。",
          },
          "160447306": {
            title: "ソファ用厚手無地リネン調クッション生地（ホワイト）",
            detail: "ソファやクッションのカバー製作などに使う、厚手の無地リネン調生地です。カラーはホワイトです。正確な素材組成、寸法、販売単位、洗濯方法は、仕入先の商品画像と仕様をご確認ください。",
          },
          "160447308": {
            title: "幾何学模様のベッドサイドマット 40×60cm",
            detail: "幾何学模様をあしらった、40×60cmのベッドサイド用マットです。商品名には装飾用の敷物として記載されています。素材、厚み、お手入れ方法など、商品名に明記されていない仕様は商品画像および仕入先の情報をご確認ください。",
          },
          "160454016": {
            title: "日本式窯焼き抹茶茶器セット（青釉）",
            detail: "日本式の窯焼き仕上げをうたう、青釉カラーの抹茶用茶器セットです。セット内容、寸法、素材、食器としての使用可否などは、商品画像および仕入先の仕様を確認してからご注文ください。",
          },
        };
        const copy: JapaneseCopy = fixedCopyByItemId[itemId] ??
          (deterministicCopyIsSafe
            ? { title: deterministicTitle!, detail: deterministicDetail! }
            : await translate(originalTitle, originalDetail));
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
          titleJapanese: hasUsableJapaneseCopy(text(after.title), "title"),
          descriptionJapanese: hasUsableJapaneseCopy(text(after.detail)),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        if (/HTTP 429|RESOURCE_EXHAUSTED|quota exceeded|billing details|timed out|timeout/i.test(message)) {
          providerUnavailable = true;
          results.push({
            itemId,
            outcome: "deferred_ai_provider_unavailable",
            reason: message.slice(0, 180),
          });
          continue;
        }
        results.push({
          itemId,
          outcome: "failed",
          error: message.slice(0, 180),
        });
      }
    }
  }
  // Run sequentially: the previous five-way fan-out exhausted Gemini quota and caused
  // every item in a batch to fail. Small batches avoid amplifying 429/timeouts.
  await worker();
  const translated = results.filter((item) => item.outcome === "translated_and_verified").length;
  const failed = results.filter((item) => !["translated_and_verified", "already_japanese_on_readback", "deferred_ai_provider_unavailable"].includes(String(item.outcome))).length;
  const deferred = results.filter((item) => item.outcome === "deferred_ai_provider_unavailable").length;
  const response = {
    ok: failed === 0,
    complete: candidatePool.length === 0 || (translated === candidates.length && deferred === 0),
    phase: "base_japanese_copy_repair",
    snapshotItems: snapshot.items.length,
    pages: snapshot.pages,
    candidatePool: candidatePool.length,
    rotationOffset,
    emptyPoolProbe,
    requested: candidates.length,
    translatedAndVerified: translated,
    failed,
    deferred,
    providerUnavailable,
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
    providerUnavailable: response.providerUnavailable,
    remainingEnglishEstimate: response.remainingEnglishEstimate,
    emptyPoolProbe,
    successfulResults: results.filter((item) => item.outcome === "translated_and_verified").map((item) => ({
      itemId: item.itemId,
      outcome: item.outcome,
      titleJapanese: item.titleJapanese,
      descriptionJapanese: item.descriptionJapanese,
      pricePreserved: item.pricePreserved,
      stockPreserved: item.stockPreserved,
      visibilityPreserved: item.visibilityPreserved,
      identifierPreserved: item.identifierPreserved,
    })),
    failedResults: results.filter((item) => item.outcome === "failed" || item.outcome === "readback_mismatch" || item.outcome === "skipped_live_item_state_incomplete").map((item) => ({
      itemId: item.itemId,
      outcome: item.outcome,
      error: item.error,
    })),
  }));
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}
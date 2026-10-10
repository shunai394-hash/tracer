const NON_PRODUCT_TITLE_MARKERS = [
  "商品アイデンティティが未確定",
  "選定対象外",
  "必須ゲートを満たしていない",
  "テスト優先度は低い",
  "販売停止中の商品",
  "商品の仕様・サイズ・素材・使用方法は",
  "観測された需要と供給データに基",
  "販売テスト候補になる",
  "seeded_dueアイテム",
  "sales_test_gate_not_passed",
  "identity_pending",
  "supplier_variant_identity_missing",
] as const;

/**
 * Reject workflow/status text accidentally persisted as a buyer-facing title.
 * This is intentionally a narrow safety check, not a substitute for the
 * canonical sales-test gate or verified supplier identity.
 */
export function isPublishableCatalogTitle(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const title = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!title || title.length > 180) return false;
  const normalized = title.toLocaleLowerCase("ja-JP");
  return !NON_PRODUCT_TITLE_MARKERS.some((marker) =>
    normalized.includes(marker.normalize("NFKC").toLocaleLowerCase("ja-JP")),
  );
}

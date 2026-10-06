export function isJapaneseProductTitle(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const title = value.normalize("NFKC").trim();
  if (!title) return false;
  const japanese = (title.match(/[ぁ-んァ-ヶ一-龯々〆ヵー]/g) ?? []).length;
  return japanese >= 2;
}

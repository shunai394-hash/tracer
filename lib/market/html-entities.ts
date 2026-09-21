/**
 * Shared HTML entity decoding used by every marketplace ranking/detail parser.
 *
 * The previous implementation only unescaped a handful of entities
 * (`&amp; &quot; &#39; &lt; &gt;`) via sequential `.replace()` calls. That
 * approach had two problems:
 *  - It never decoded numeric character references (`&#12316;`, `&#x301C;`)
 *    or common named entities (`&nbsp;`, `&yen;` …), which are frequent in
 *    Japanese marketplace listings (wave dash, yen sign, middle dot, etc.).
 *    Those showed up verbatim in titles, which looked like "文字化け".
 *  - Running `.replace()` calls back to back on the same string can
 *    double-decode content (e.g. text containing the literal `&amp;lt;`
 *    would first become `&lt;`, then get decoded a second time into `<`).
 *
 * `decodeHtmlEntities` fixes both by resolving every entity in a single
 * regex pass over the original string.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: "\u00a0",
  yen: "\u00a5",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  middot: "\u00b7",
};

const ENTITY_PATTERN = /&(#x[0-9a-f]+|#[0-9]+|[a-z0-9]+);/gi;

function decodeNumericEntity(body: string): string | null {
  const isHex = body[0] === "x" || body[0] === "X";
  const codePoint = isHex ? Number.parseInt(body.slice(1), 16) : Number.parseInt(body, 10);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return null;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}

/**
 * Decodes HTML entities (numeric and the common named ones seen in
 * marketplace HTML) in a single pass. Unknown entities are left untouched
 * rather than guessed at.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (match, entity: string) => {
    if (entity[0] === "#") {
      const decoded = decodeNumericEntity(entity.slice(1));
      return decoded ?? match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

export function verifyHtmlEntityDecodingInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const cases = [
    {
      name: "decodes_basic_named_entities",
      expected: true,
      actual: decodeHtmlEntities("A &amp; B &lt;tag&gt; &quot;quoted&quot;") === 'A & B <tag> "quoted"',
    },
    {
      name: "decodes_decimal_numeric_entity_wave_dash",
      expected: true,
      actual: decodeHtmlEntities("\u697d\u5929&#12316;\u30e4\u30d5\u30fc") === "\u697d\u5929\u301c\u30e4\u30d5\u30fc",
    },
    {
      name: "decodes_hex_numeric_entity",
      expected: true,
      actual: decodeHtmlEntities("&#x301C;") === "\u301c",
    },
    {
      name: "decodes_nbsp_and_yen",
      expected: true,
      actual: decodeHtmlEntities("&yen;1,000&nbsp;\u5186") === "\u00a51,000\u00a0\u5186",
    },
    {
      name: "leaves_unknown_entities_untouched",
      expected: true,
      actual: decodeHtmlEntities("&notarealentity;") === "&notarealentity;",
    },
    {
      name: "does_not_double_decode",
      expected: true,
      actual: decodeHtmlEntities("&amp;lt;") === "&lt;",
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}

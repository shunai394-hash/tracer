/**
 * Charset detection/decoding for marketplace pages fetched as raw bytes.
 *
 * `fetch(...).text()` decodes strictly using the charset parameter of the
 * response's Content-Type header, defaulting to UTF-8 when that header is
 * missing or has no charset. Some Japanese shop pages (older Yahoo!
 * ショッピング shop templates in particular) are still served as
 * Shift_JIS/EUC-JP without a charset in the HTTP header, relying on the
 * `<meta charset>` tag instead. Blindly decoding those bytes as UTF-8
 * corrupts every multi-byte character ("文字化け").
 *
 * This module inspects, in order:
 *   1. The `charset` parameter on the Content-Type header (most reliable).
 *   2. A `<meta charset="...">` or `<meta http-equiv="Content-Type" ...>`
 *      tag sniffed from the first bytes of the document (read byte-safe,
 *      without assuming an encoding up front).
 *   3. UTF-8, as a safe default.
 */

const DEFAULT_CHARSET = "utf-8";
const SNIFF_WINDOW_BYTES = 4096;

function normalizeCharsetLabel(label: string): string {
  const compact = label.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact === "shiftjis" || compact === "sjis" || compact === "xsjis" || compact === "cp932" || compact === "windows31j") {
    return "shift_jis";
  }
  if (compact === "eucjp" || compact === "xeucjp") {
    return "euc-jp";
  }
  if (compact === "utf8") {
    return "utf-8";
  }
  return label.trim().toLowerCase();
}

export function detectCharsetFromContentType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const match = contentType.match(/charset\s*=\s*"?([^;"\s]+)"?/i);
  return match ? normalizeCharsetLabel(match[1]) : null;
}

export function detectCharsetFromMetaBytes(bytes: Uint8Array): string | null {
  // Meta charset declarations are always ASCII-safe, so decoding the sniff
  // window as latin1 (1 byte -> 1 code unit, lossless for this purpose) is
  // enough to find them regardless of the document's real encoding.
  const window = bytes.subarray(0, Math.min(bytes.length, SNIFF_WINDOW_BYTES));
  let head = "";
  for (let i = 0; i < window.length; i += 1) {
    head += String.fromCharCode(window[i]);
  }

  const metaCharset = head.match(/<meta[^>]+charset\s*=\s*["']?([a-z0-9_-]+)/i);
  if (metaCharset) return normalizeCharsetLabel(metaCharset[1]);

  const httpEquiv = head.match(/<meta[^>]+http-equiv=["']content-type["'][^>]*content=["'][^"']*charset=([a-z0-9_-]+)/i);
  if (httpEquiv) return normalizeCharsetLabel(httpEquiv[1]);

  return null;
}

export function resolveCharset(contentType: string | null | undefined, bytes: Uint8Array): string {
  return (
    detectCharsetFromContentType(contentType) ??
    detectCharsetFromMetaBytes(bytes) ??
    DEFAULT_CHARSET
  );
}

/**
 * Decodes raw response bytes into text, choosing the charset from the
 * HTTP header first, then a `<meta charset>` sniff, then UTF-8. Falls back
 * to a permissive UTF-8 decode if the resolved label is not supported by
 * the runtime's TextDecoder (keeps behaviour identical to the previous
 * `response.text()` call in that case, rather than throwing).
 */
export function decodeHtmlBytes(bytes: Uint8Array, contentType: string | null | undefined): string {
  const charset = resolveCharset(contentType, bytes);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder(DEFAULT_CHARSET, { fatal: false }).decode(bytes);
  }
}

const CJK_OR_KANA_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

function containsCjkOrKana(text: string): boolean {
  return CJK_OR_KANA_PATTERN.test(text);
}

/**
 * Repairs a specific, well-known corruption pattern in text that already
 * arrived as a JS string (not raw bytes) via a third-party JSON API —
 * e.g. Bright Data's scrape response — where `decodeHtmlBytes` above never
 * runs because there are no raw bytes to hand it, only whatever string the
 * upstream service already produced. When that upstream service decodes a
 * UTF-8-encoded source page one byte at a time as Latin-1 before handing it
 * back as JSON text, every original multi-byte Japanese character becomes
 * 2-3 separate Latin-1-range characters ("文字化け", e.g. "無" becomes
 * "ç¡").
 *
 * This is reversible and self-verifying, not a guess: a JS string can only
 * have come from that specific corruption if every UTF-16 code unit fits in
 * a single byte (0x00-0xFF) — a real Japanese character's code unit is
 * always above 0xFF, so genuine Unicode text is left untouched. The
 * candidate repair (reinterpreting those code units as raw UTF-8 bytes) is
 * only accepted when it decodes cleanly AND actually produces CJK/kana
 * characters the original didn't have; otherwise the original string is
 * returned unchanged, so plain ASCII/English text is never touched.
 */
export function repairMojibakeText(text: string): string {
  if (!text) return text;

  // Every UTF-16 code unit of a real CJK/kana character is above 0xFF, so
  // this loop bailing out also means "text already contains real Japanese
  // text" — there is nothing this function needs to touch either way.
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0xff) return text;
  }

  const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0));
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return text;
  }

  return containsCjkOrKana(decoded) ? decoded : text;
}

export function verifyCharsetDecodingInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const utf8Bytes = new TextEncoder().encode("<html><body>\u30c6\u30b9\u30c8</body></html>");
  // "テスト" encoded as Shift_JIS (0x83 0x65 / 0x83 0x58 / 0x83 0x67).
  const shiftJisBytes = new Uint8Array([
    0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, // <html>
    0x83, 0x65, 0x83, 0x58, 0x83, 0x67, // テスト in Shift_JIS
    0x3c, 0x2f, 0x68, 0x74, 0x6d, 0x6c, 0x3e, // </html>
  ]);
  const shiftJisWithMeta = new Uint8Array([
    ...Array.from(
      new TextEncoder().encode('<html><head><meta charset="Shift_JIS"></head><body>'),
    ),
    ...Array.from(shiftJisBytes.subarray(6, 12)),
    ...Array.from(new TextEncoder().encode("</body></html>")),
  ]);

  const cases = [
    {
      name: "content_type_header_wins",
      expected: true,
      actual: resolveCharset("text/html; charset=Shift_JIS", utf8Bytes) === "shift_jis",
    },
    {
      name: "meta_charset_sniffed_when_header_missing",
      expected: true,
      actual: resolveCharset(null, shiftJisWithMeta) === "shift_jis",
    },
    {
      name: "defaults_to_utf8_with_no_signal",
      expected: true,
      actual: resolveCharset(null, utf8Bytes) === "utf-8",
    },
    {
      name: "decodes_shift_jis_bytes_correctly",
      expected: true,
      actual: decodeHtmlBytes(shiftJisBytes, "text/html; charset=Shift_JIS").includes("\u30c6\u30b9\u30c8"),
    },
    {
      name: "decoding_as_utf8_would_have_been_wrong",
      expected: true,
      actual: !new TextDecoder("utf-8").decode(shiftJisBytes).includes("\u30c6\u30b9\u30c8"),
    },
    {
      name: "utf8_bytes_still_decode_correctly",
      expected: true,
      actual: decodeHtmlBytes(utf8Bytes, "text/html; charset=utf-8").includes("\u30c6\u30b9\u30c8"),
    },
    {
      // Simulates Bright Data (or any upstream JSON API) decoding a
      // UTF-8-encoded page one byte at a time as Latin-1 before returning
      // it as a JS string \u2014 the exact corruption reported in production
      // ("\u7121" -> "\u00e7\u00a1"), with no raw bytes available to hand to
      // decodeHtmlBytes.
      name: "repairs_utf8_bytes_that_were_reinterpreted_as_latin1",
      expected: true,
      actual: (() => {
        const original = "\u7121\u6599\u767a\u9001"; // \u7121\u6599\u767a\u9001
        const utf8AsBytes = new TextEncoder().encode(original);
        let asLatin1 = "";
        for (const byte of utf8AsBytes) asLatin1 += String.fromCharCode(byte);
        return repairMojibakeText(asLatin1) === original;
      })(),
    },
    {
      name: "already_correct_japanese_text_is_left_untouched",
      expected: true,
      actual: repairMojibakeText("\u30c6\u30b9\u30c8\u5546\u54c1") === "\u30c6\u30b9\u30c8\u5546\u54c1",
    },
    {
      name: "plain_ascii_title_is_left_untouched",
      expected: true,
      actual: repairMojibakeText("iPhone 15 Pro Case") === "iPhone 15 Pro Case",
    },
    {
      name: "empty_string_is_left_untouched",
      expected: true,
      actual: repairMojibakeText("") === "",
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}

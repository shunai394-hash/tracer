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
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}

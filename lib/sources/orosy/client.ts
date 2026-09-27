import "server-only";

import { getOrosyConfig } from "@/lib/config/env";

function repairMojibake(value: string | null | undefined): string | null {
  if (value == null || value === "") return value ?? null;

  const score = (text: string): number => {
    const japanese =
      (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;

    const bad =
      (text.match(/[ÃÂâðåæçèéêëìíîïñòóôõöøùúûüýþ]/g) ?? []).length;

    const replacement = (text.match(/�/g) ?? []).length;

    return japanese * 10 - bad * 3 - replacement * 20;
  };

  let current = value;

  for (let i = 0; i < 3; i++) {
    try {
      /*
       * Orosy側でUTF-8バイト列が1バイト文字として
       * 誤解釈された文字列を元のUTF-8に戻す。
       *
       * 例:
       *   "å..." → UTF-8 bytes → UTF-8 decode → 日本語
       */
      const bytes: number[] = [];

      for (const char of current) {
        const code = char.charCodeAt(0);

        if (code <= 0xff) {
          bytes.push(code);
        } else {
          const encoded = new TextEncoder().encode(char);
          for (const byte of encoded) {
            bytes.push(byte);
          }
        }
      }

      const repaired = new TextDecoder("utf-8", {
        fatal: false,
      }).decode(new Uint8Array(bytes));

      if (repaired.includes("�")) break;

      if (score(repaired) > score(current)) {
        current = repaired;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return current;
}
export async function orosyRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { apiKey, baseUrl } = getOrosyConfig();

  if (!apiKey) {
    throw new Error("OROSY_API_KEY is not configured");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Orosy API error: ${response.status} ${await response.text()}`,
    );
  }

  const bytes = await response.arrayBuffer();
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return JSON.parse(text) as T;
}

export { repairMojibake };







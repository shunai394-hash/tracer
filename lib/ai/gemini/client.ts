import "server-only";

import { getGeminiConfig } from "@/lib/config/env";
import {
  GeminiConfigError,
  GeminiRequestError,
  GeminiTimeoutError,
} from "@/lib/ai/gemini/errors";

const DEFAULT_TIMEOUT_MS = 15_000;

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: {
    message?: string;
    status?: string;
  };
};

export type GeminiStructuredRequest = {
  prompt: string;
  systemInstruction?: string;
  timeoutMs?: number;
};

export function isGeminiConfigured(): boolean {
  return Boolean(getGeminiConfig().apiKey);
}

export function getGeminiClient() {
  const { apiKey, model } = getGeminiConfig();
  if (!apiKey) {
    throw new GeminiConfigError();
  }
  return { apiKey, model };
}

export async function generateStructuredJson<T>(
  request: GeminiStructuredRequest,
): Promise<T> {
  const { apiKey, model } = getGeminiClient();
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: request.systemInstruction
            ? { parts: [{ text: request.systemInstruction }] }
            : undefined,
          contents: [{ parts: [{ text: request.prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        }),
      });

      const payload = (await response.json()) as GeminiGenerateContentResponse;
      if (!response.ok) {
        const error = new GeminiRequestError(
          `Gemini request failed: HTTP ${response.status} ${payload.error?.status ?? ""} ${payload.error?.message ?? ""}`.trim(),
          response.status,
        );
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        throw error;
      }

      if (payload.error?.message) {
        throw new GeminiRequestError(
          `Gemini request failed: ${payload.error.status ?? ""} ${payload.error.message}`.trim(),
        );
      }

      const responseText = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim();
      if (!responseText) throw new GeminiRequestError("Gemini returned an empty response");
      try {
        return JSON.parse(responseText) as T;
      } catch {
        throw new GeminiRequestError("Gemini returned invalid JSON");
      }
    } catch (error) {
      if (error instanceof GeminiConfigError) throw error;
      if (error instanceof GeminiRequestError) {
        if (error.status !== undefined && [429, 500, 502, 503, 504].includes(error.status) && attempt < 2) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new GeminiTimeoutError();
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        throw lastError;
      }
      throw new GeminiRequestError("Gemini request failed");
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new GeminiRequestError("Gemini request failed");

}


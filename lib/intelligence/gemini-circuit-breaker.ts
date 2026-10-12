export type GeminiProviderFailure = {
  status?: unknown;
  code?: unknown;
  message?: unknown;
};

export function isGeminiCircuitBreakerFailure(error: unknown): boolean {
  const value = error && typeof error === "object" ? error as GeminiProviderFailure : {};
  const status = Number(value.status);
  const code = String(value.code ?? "");
  const message = error instanceof Error ? error.message : String(value.message ?? error ?? "");
  return status === 429
    || status === 503
    || code === "GEMINI_TIMEOUT"
    || /RESOURCE_EXHAUSTED|UNAVAILABLE|quota exceeded|high demand|GEMINI_TIMEOUT|Gemini request timed out/i.test(message);
}

export function createGeminiRunCircuitBreaker() {
  let open = false;
  return {
    isOpen: () => open,
    recordFailure(error: unknown) {
      if (isGeminiCircuitBreakerFailure(error)) open = true;
      return open;
    },
    canCall(calls: number, maxCalls: number) {
      return !open && calls < maxCalls;
    },
  };
}

export class GeminiConfigError extends Error {
  readonly code = "GEMINI_NOT_CONFIGURED" as const;

  constructor(message = "Gemini API key is not configured") {
    super(message);
    this.name = "GeminiConfigError";
  }
}

export class GeminiRequestError extends Error {
  readonly code = "GEMINI_REQUEST_FAILED" as const;
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GeminiRequestError";
    this.status = status;
  }
}

export class GeminiTimeoutError extends Error {
  readonly code = "GEMINI_TIMEOUT" as const;

  constructor(message = "Gemini request timed out") {
    super(message);
    this.name = "GeminiTimeoutError";
  }
}

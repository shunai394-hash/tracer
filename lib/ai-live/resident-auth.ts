import { timingSafeEqual } from "node:crypto";

const SECRET_RESOURCE = /^projects\/[a-z0-9-]{1,80}\/secrets\/[A-Za-z0-9_-]{1,80}\/versions\/[A-Za-z0-9_-]{1,40}$/;

export type WorkerAuthSource = "env" | "secret_manager" | "unconfigured";

type Env = Record<string, string | undefined>;

export function workerAuthSource(env: Env): WorkerAuthSource {
  if (env.TRACER_AI_LIVE_ADMIN_TOKEN?.trim()) return "env";
  if (SECRET_RESOURCE.test(env.TRACER_AI_LIVE_ADMIN_SECRET?.trim() || "")) return "secret_manager";
  return "unconfigured";
}

export function tokensMatch(expected: string, supplied: string): boolean {
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export function readBearer(header: string | undefined): string {
  if (!header) return "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : "";
}

async function secretManagerAccessToken(env: Env, fetchImpl: typeof fetch): Promise<string | null> {
  const direct = env.TRACER_AI_LIVE_SECRET_ACCESS_TOKEN?.trim();
  if (direct) return direct;
  if (env.TRACER_AI_LIVE_SECRET_METADATA !== "1") return null;
  const response = await fetchImpl(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" }, cache: "no-store", signal: AbortSignal.timeout(5_000) },
  );
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { access_token?: unknown } | null;
  return typeof body?.access_token === "string" && body.access_token.trim() ? body.access_token.trim() : null;
}

/**
 * Loads the worker control token from the environment or Secret Manager.
 * The token is returned only to the caller. This function does not log,
 * persist, or include the token in an error.
 */
export async function resolveWorkerAdminToken(env: Env, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const fromEnv = env.TRACER_AI_LIVE_ADMIN_TOKEN?.trim();
  if (fromEnv) return fromEnv.length <= 512 ? fromEnv : null;
  const resource = env.TRACER_AI_LIVE_ADMIN_SECRET?.trim() || "";
  if (!SECRET_RESOURCE.test(resource)) return null;
  try {
    const accessToken = await secretManagerAccessToken(env, fetchImpl);
    if (!accessToken) return null;
    const response = await fetchImpl(`https://secretmanager.googleapis.com/v1/${resource}:access`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as { payload?: { data?: unknown } } | null;
    const encoded = body?.payload?.data;
    if (typeof encoded !== "string" || !encoded) return null;
    const token = Buffer.from(encoded, "base64").toString("utf8").trim();
    if (!token || token.length > 512) return null;
    return token;
  } catch {
    return null;
  }
}

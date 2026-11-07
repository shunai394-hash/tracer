import { randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "tracer_ai_live_youtube_oauth_state";
const STATE_TTL_SECONDS = 600;
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";

function authorizedAdmin(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN ?? "";
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

/** Starts a browser OAuth redirect. The short-lived state is bound to an HttpOnly cookie. */
export async function POST(request: Request) {
  if (!authorizedAdmin(request)) return json({ ok: false, error: "unauthorized" }, 401);

  const clientId = process.env.YOUTUBE_CLIENT_ID?.trim();
  const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !redirectUri) {
    return json({ ok: false, error: "youtube_oauth_client_not_configured" }, 503);
  }
  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(redirectUri);
  } catch {
    return json({ ok: false, error: "youtube_oauth_redirect_uri_invalid" }, 503);
  }
  if (parsedRedirect.protocol !== "https:" || parsedRedirect.origin !== "https://tracer-pied-alpha.vercel.app") {
    return json({ ok: false, error: "youtube_oauth_redirect_uri_invalid" }, 503);
  }

  const state = randomBytes(32).toString("base64url");
  const authorization = new URL(AUTH_ENDPOINT);
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", YOUTUBE_SCOPE);
  authorization.searchParams.set("access_type", "offline");
  authorization.searchParams.set("prompt", "consent");
  authorization.searchParams.set("include_granted_scopes", "true");
  authorization.searchParams.set("state", state);

  const response = json({ ok: true, authorizationUrl: authorization.toString(), expiresInSeconds: STATE_TTL_SECONDS });
  response.headers.append(
    "Set-Cookie",
    `${STATE_COOKIE}=${state}; Path=/api/admin/ai-live/youtube/callback; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  );
  return response;
}

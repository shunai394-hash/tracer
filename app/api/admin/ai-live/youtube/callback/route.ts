import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { encryptYouTubeRefreshToken } from "@/lib/ai-live/youtube-token-crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const STATE_COOKIE = "tracer_ai_live_youtube_oauth_state";
const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";

function redirectResult(requestUrl: URL, result: "connected" | "failed") {
  const destination = new URL("/admin/operations", requestUrl.origin);
  destination.searchParams.set("youtube", result);
  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.append(
    "Set-Cookie",
    `${STATE_COOKIE}=; Path=/api/admin/ai-live/youtube/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  );
  return response;
}

function stateMatches(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** OAuth callback: validates browser-bound state, exchanges code, stores only AES-256-GCM ciphertext. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.has("error")) return redirectResult(url, "failed");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const cookieHeader = request.headers.get("cookie") ?? "";
  const stateCookie = cookieHeader.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${STATE_COOKIE}=`))?.slice(STATE_COOKIE.length + 1) ?? "";

  if (!code || code.length > 4096 || !state || state.length > 256 || !stateCookie || !stateMatches(state, stateCookie)) {
    return redirectResult(url, "failed");
  }

  const clientId = process.env.YOUTUBE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI?.trim() ?? "";
  if (!clientId || !clientSecret || !redirectUri || !process.env.AI_LIVE_OAUTH_ENCRYPTION_KEY) {
    return redirectResult(url, "failed");
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: "authorization_code",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenResponse.ok) return redirectResult(url, "failed");
    const payload: unknown = await tokenResponse.json();
    if (!payload || typeof payload !== "object") return redirectResult(url, "failed");
    const tokens = payload as Record<string, unknown>;
    const grantedScopes = typeof tokens.scope === "string" ? tokens.scope.split(" ") : [];
    if (
      typeof tokens.refresh_token !== "string" ||
      tokens.refresh_token.length < 10 || tokens.refresh_token.length > 8192 ||
      typeof tokens.access_token !== "string" ||
      tokens.access_token.length < 20 || tokens.access_token.length > 8192 ||
      !Number.isFinite(tokens.expires_in) ||
      Number(tokens.expires_in) < 60 ||
      typeof tokens.token_type !== "string" ||
      tokens.token_type.toLowerCase() !== "bearer" ||
      !grantedScopes.includes(YOUTUBE_SCOPE)
    ) return redirectResult(url, "failed");

    const encrypted = encryptYouTubeRefreshToken(tokens.refresh_token);
    const db = createSupabaseAdminClient();
    const { error } = await db.from("ai_live_oauth_credentials").upsert({
      id: "youtube_primary",
      provider: "youtube",
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      scope: YOUTUBE_SCOPE,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
    if (error) throw new Error("youtube_oauth_persistence_failed");
    return redirectResult(url, "connected");
  } catch {
    return redirectResult(url, "failed");
  }
}

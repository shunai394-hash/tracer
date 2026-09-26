import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const accessToken = process.env.BASE_ACCESS_TOKEN?.trim() || "";
  const clientId = process.env.BASE_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.BASE_CLIENT_SECRET?.trim() || "";
  const redirectUri = process.env.BASE_OAUTH_REDIRECT_URI?.trim() || "";

  return NextResponse.json({
    ok: true,
    base: {
      oauthConfigured: Boolean(clientId && clientSecret && redirectUri),
      accessTokenConfigured: Boolean(accessToken),
      redirectUriConfigured: Boolean(redirectUri),
    },
  });
}

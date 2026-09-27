import { NextResponse } from "next/server";

export const runtime = "nodejs";

const BASE_API_URL = process.env.BASE_API_URL?.trim() || "https://api.thebase.in/1";
const CLIENT_ID = process.env.BASE_CLIENT_ID?.trim() || "";
const CLIENT_SECRET = process.env.BASE_CLIENT_SECRET?.trim() || "";
const REDIRECT_URI = process.env.BASE_REDIRECT_URI?.trim() || "";

function html(message: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TRACER × BASE</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;line-height:1.7}code,pre{background:#f4f4f5;border-radius:8px;padding:12px;display:block;overflow:auto;white-space:pre-wrap;word-break:break-all}</style></head><body>${message}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const oauthErrorDescription = url.searchParams.get("error_description");
  const cookie = request.headers.get("cookie") || "";
  const stateMatch = cookie.match(/(?:^|;\s*)tracer_base_oauth_state=([^;]+)/);
  const expectedState = stateMatch?.[1];

  if (oauthError) {
    return html(`<h1>BASE認証が拒否されました</h1><p>${oauthErrorDescription || oauthError}</p>`, 400);
  }

  if (!code || !state) {
    return html("<h1>BASE認証エラー</h1><p>認可コードまたはstateがありません。</p>", 400);
  }

  if (!expectedState || state !== decodeURIComponent(expectedState)) {
    return html("<h1>BASE認証エラー</h1><p>stateの検証に失敗しました。最初から認証をやり直してください。</p>", 400);
  }

  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return html("<h1>TRACER設定エラー</h1><p>BASE_CLIENT_ID / BASE_CLIENT_SECRET / BASE_REDIRECT_URI が未設定です。</p>", 500);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
  });

  const tokenResponse = await fetch(`${BASE_API_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    cache: "no-store",
  });

  const raw = await tokenResponse.text();
  let tokenData: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    error?: string;
    error_description?: string;
  } = {};

  try {
    tokenData = JSON.parse(raw);
  } catch {
    return html(`<h1>BASEトークン取得エラー</h1><pre>${raw.slice(0, 1000)}</pre>`, 502);
  }

  if (!tokenResponse.ok || !tokenData.refresh_token) {
    return html(`<h1>BASEトークン取得エラー</h1><pre>${JSON.stringify(tokenData, null, 2)}</pre>`, 502);
  }

  const response = html(
    `<h1>BASE連携に成功しました</h1>
<p>次の <strong>Refresh Token</strong> をVercelのProduction Environment Variableに登録してください。</p>
<p>Key: <code>BASE_REFRESH_TOKEN</code></p>
<pre>${tokenData.refresh_token}</pre>
<p>登録後、この画面を閉じて構いません。Refresh Tokenはこの画面以外に保存していません。</p>`,
  );

  response.cookies.delete("tracer_base_oauth_state");
  return response;
}

import "server-only";

const BASE_API_URL = process.env.BASE_API_URL?.trim() || "https://api.thebase.in/1";
const BASE_CLIENT_ID = process.env.BASE_CLIENT_ID?.trim() || "";
const BASE_CLIENT_SECRET = process.env.BASE_CLIENT_SECRET?.trim() || "";

export function getBaseOAuthConfig() {
  return {
    clientId: BASE_CLIENT_ID,
    clientSecret: BASE_CLIENT_SECRET,
    redirectUri: process.env.BASE_OAUTH_REDIRECT_URI?.trim() || "",
    apiUrl: BASE_API_URL,
  };
}

export function getBaseAuthorizationUrl(state: string) {
  const config = getBaseOAuthConfig();
  if (!config.clientId) throw new Error("BASE_CLIENT_ID is not configured");
  if (!config.redirectUri) throw new Error("BASE_OAUTH_REDIRECT_URI is not configured");

  const url = new URL("/1/oauth/authorize", "https://api.thebase.in");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeBaseAuthorizationCode(code: string) {
  const config = getBaseOAuthConfig();
  if (!config.clientId) throw new Error("BASE_CLIENT_ID is not configured");
  if (!config.clientSecret) throw new Error("BASE_CLIENT_SECRET is not configured");
  if (!config.redirectUri) throw new Error("BASE_OAUTH_REDIRECT_URI is not configured");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
  });

  const response = await fetch(`${config.apiUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    cache: "no-store",
  });

  const text = await response.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(`BASE OAuth token HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return data ?? { raw: text };
}

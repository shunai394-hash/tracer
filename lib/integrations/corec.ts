import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { getCorecConfig } from "@/lib/config/env";

const CORECOAUTH_AUTHORIZE_URL = "https://corec.jp/oauth/authorize";
const CORECOAUTH_TOKEN_URL = "https://corec.jp/oauth/token";
const CORECOAPI_BASE_URL = "https://corec.jp";

export type CorecToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
};

export type CorecOrder = {
  id?: string | number;
  order_number?: string | null;
  ordered_at?: string | null;
  grand_total?: number | null;
  supplier_company_name?: string | null;
};

function required(value: string, name: string): string {
  if (!value) throw new Error(`COREC_${name}_NOT_CONFIGURED`);
  return value;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function deriveKey(secret: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(secret).digest());
}

export function createCorecState(): string {
  return randomBytes(32).toString("base64url");
}

export function getCorecAuthorizationUrl(state: string): string {
  const config = getCorecConfig();
  const clientId = required(config.clientId, "CLIENT_ID");
  const redirectUri = required(config.redirectUri, "REDIRECT_URI");
  const url = new URL(CORECOAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCorecCode(code: string): Promise<CorecToken> {
  const config = getCorecConfig();
  const body = new FormData();
  body.set("grant_type", "authorization_code");
  body.set("client_id", required(config.clientId, "CLIENT_ID"));
  body.set("client_secret", required(config.clientSecret, "CLIENT_SECRET"));
  body.set("code", code);
  body.set("redirect_uri", required(config.redirectUri, "REDIRECT_URI"));

  const response = await fetch(CORECOAUTH_TOKEN_URL, {
    method: "POST",
    body,
    cache: "no-store",
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `COREC_TOKEN_EXCHANGE_FAILED:${response.status}:${JSON.stringify(payload)}`,
    );
  }

  return {
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token ?? ""),
    expiresAt: Date.now() + Math.max(60, Number(payload.expires_in ?? 3600)) * 1000,
    scope: String(payload.scope ?? config.scope),
  };
}

export async function refreshCorecToken(refreshToken: string): Promise<CorecToken> {
  const config = getCorecConfig();
  const body = new FormData();
  body.set("grant_type", "refresh_token");
  body.set("client_id", required(config.clientId, "CLIENT_ID"));
  body.set("client_secret", required(config.clientSecret, "CLIENT_SECRET"));
  body.set("refresh_token", refreshToken);

  const response = await fetch(CORECOAUTH_TOKEN_URL, {
    method: "POST",
    body,
    cache: "no-store",
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `COREC_TOKEN_REFRESH_FAILED:${response.status}:${JSON.stringify(payload)}`,
    );
  }

  return {
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token ?? refreshToken),
    expiresAt: Date.now() + Math.max(60, Number(payload.expires_in ?? 3600)) * 1000,
    scope: String(payload.scope ?? config.scope),
  };
}

export async function getCorecBuyerOrders(accessToken: string, limit = 1): Promise<CorecOrder[]> {
  const url = new URL("/api/v1/b/orders", CORECOAPI_BASE_URL);
  url.searchParams.set("limit", String(Math.min(500, Math.max(1, limit))));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `COREC_BUYER_ORDERS_FAILED:${response.status}:${JSON.stringify(payload)}`,
    );
  }

  if (Array.isArray(payload)) return payload as CorecOrder[];
  if (Array.isArray(payload.orders)) return payload.orders as CorecOrder[];
  if (Array.isArray(payload.data)) return payload.data as CorecOrder[];
  return [];
}

export async function encryptCorecToken(token: CorecToken): Promise<string> {
  const config = getCorecConfig();
  const secret = required(config.sessionSecret, "SESSION_SECRET");
  const iv = randomBytes(12);
  const key = await crypto.subtle.importKey(
    "raw",
    deriveKey(secret),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const plaintext = new TextEncoder().encode(JSON.stringify(token));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  return [base64url(iv), base64url(ciphertext)].join(".");
}

export async function decryptCorecToken(value: string): Promise<CorecToken> {
  const config = getCorecConfig();
  const secret = required(config.sessionSecret, "SESSION_SECRET");
  const [ivPart, ciphertextPart] = value.split(".");
  if (!ivPart || !ciphertextPart) throw new Error("COREC_SESSION_INVALID");

  const key = await crypto.subtle.importKey(
    "raw",
    deriveKey(secret),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(Buffer.from(ivPart, "base64url")) },
    key,
    new Uint8Array(Buffer.from(ciphertextPart, "base64url")),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as CorecToken;
}

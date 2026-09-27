import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";

const BASE_API_URL = process.env.BASE_API_URL?.trim() || "https://api.thebase.in/1";
const CLIENT_ID = process.env.BASE_CLIENT_ID?.trim() || "";
const REDIRECT_URI = process.env.BASE_REDIRECT_URI?.trim() || "";

const SCOPES = [
  "read_users",
  "read_users_mail",
  "read_items",
  "read_orders",
  "read_savings",
  "write_items",
  "write_orders",
].join(" ");

export async function GET() {
  if (!CLIENT_ID || !REDIRECT_URI) {
    return NextResponse.json(
      { ok: false, error: "BASE_CLIENT_ID and BASE_REDIRECT_URI are not configured" },
      { status: 500 },
    );
  }

  const state = randomBytes(32).toString("hex");
  const authorizeUrl = new URL(`${BASE_API_URL}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set("tracer_base_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });

  return response;
}

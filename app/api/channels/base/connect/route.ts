import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getBaseAuthorizationUrl } from "@/lib/channels/base-oauth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const state = randomBytes(32).toString("hex");
    const response = NextResponse.redirect(getBaseAuthorizationUrl(state));
    response.cookies.set("tracer_base_oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return response;
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

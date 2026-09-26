import { NextResponse } from "next/server";
import { exchangeBaseAuthorizationCode } from "@/lib/channels/base-oauth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const expectedState = request.headers.get("cookie")?.match(/(?:^|; )tracer_base_oauth_state=([^;]+)/)?.[1] ?? "";

  if (error) {
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ ok: false, error: "BASE OAuth code is missing" }, { status: 400 });
  }
  if (!returnedState || !expectedState || returnedState !== expectedState) {
    return NextResponse.json({ ok: false, error: "BASE OAuth state mismatch" }, { status: 400 });
  }

  try {
    const token = await exchangeBaseAuthorizationCode(code);
    const response = NextResponse.json({
      ok: true,
      message: "BASE OAuth succeeded. Store the returned access_token as BASE_ACCESS_TOKEN in Vercel.",
      token,
    });
    response.cookies.set("tracer_base_oauth_state", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "cron_secret_not_configured" }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as { secret?: string } | null;
  if (!body?.secret || body.secret !== cronSecret) {
    return NextResponse.json({ ok: false, error: "invalid_secret" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set("tracer_admin_session", cronSecret, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set("tracer_admin_session", "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}

import { NextResponse } from "next/server";
import {
  createCorecState,
  getCorecAuthorizationUrl,
} from "@/lib/integrations/corec";
import { getCorecConfig } from "@/lib/config/env";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = getCorecConfig();
  if (!config.clientId || !config.clientSecret || !config.redirectUri || !config.sessionSecret) {
    return NextResponse.json(
      { ok: false, code: "COREC_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  const state = createCorecState();
  const response = NextResponse.redirect(getCorecAuthorizationUrl(state));
  response.cookies.set("tracer_corec_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return response;
}

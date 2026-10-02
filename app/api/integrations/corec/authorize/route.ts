import { NextResponse } from "next/server";
import {
  createCorecState,
  getCorecAuthorizationUrl,
} from "@/lib/integrations/corec";
import { getCorecConfig } from "@/lib/config/env";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

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

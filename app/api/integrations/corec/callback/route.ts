import { NextResponse } from "next/server";
import {
  exchangeCorecCode,
  encryptCorecToken,
  getCorecBuyerOrders,
} from "@/lib/integrations/corec";
import { getCorecConfig } from "@/lib/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.json(
      { ok: false, code: "COREC_AUTHORIZATION_DENIED", error },
      { status: 400 },
    );
  }

  const expectedState = request.headers.get("cookie")?.match(
    /(?:^|; )tracer_corec_oauth_state=([^;]+)/,
  )?.[1];

  if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
    return NextResponse.json(
      { ok: false, code: "COREC_OAUTH_STATE_INVALID" },
      { status: 400 },
    );
  }

  try {
    const token = await exchangeCorecCode(code);
    const orders = await getCorecBuyerOrders(token.accessToken, 1);
    const session = await encryptCorecToken(token);
    const response = NextResponse.json({
      ok: true,
      connected: true,
      scope: token.scope,
      expiresAt: token.expiresAt,
      orderProbe: {
        ok: true,
        count: orders.length,
        firstOrderId: orders[0]?.id ?? null,
      },
    });

    response.cookies.set("tracer_corec_oauth_state", "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    response.cookies.set("tracer_corec_session", session, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, code: "COREC_CONNECTION_FAILED", message },
      { status: 502 },
    );
  }
}

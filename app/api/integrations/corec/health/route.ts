import { NextResponse } from "next/server";
import {
  decryptCorecToken,
  getCorecBuyerOrders,
  refreshCorecToken,
  encryptCorecToken,
} from "@/lib/integrations/corec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cookie = request.headers.get("cookie")?.match(
    /(?:^|; )tracer_corec_session=([^;]+)/,
  )?.[1];

  if (!cookie) {
    return NextResponse.json(
      { ok: false, connected: false, code: "COREC_NOT_CONNECTED" },
      { status: 401 },
    );
  }

  try {
    let token = await decryptCorecToken(cookie);
    if (token.expiresAt <= Date.now() + 30_000) {
      if (!token.refreshToken) {
        return NextResponse.json(
          { ok: false, connected: false, code: "COREC_TOKEN_EXPIRED" },
          { status: 401 },
        );
      }
      token = await refreshCorecToken(token.refreshToken);
    }

    const orders = await getCorecBuyerOrders(token.accessToken, 1);
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

    if (token.expiresAt > Date.now() + 30_000) {
      response.cookies.set("tracer_corec_session", await encryptCorecToken(token), {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, connected: false, code: "COREC_HEALTH_FAILED", message },
      { status: 502 },
    );
  }
}

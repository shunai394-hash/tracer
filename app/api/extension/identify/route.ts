import { NextResponse } from "next/server";

import {
  EMPTY_IDENTIFIERS,
  identifiersFromRecord,
  matchProductIdentity,
} from "@/lib/market/identifiers";
import { getExtensionConfig } from "@/lib/config/env";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const expectedKey = getExtensionConfig().apiKey;
  const suppliedKey = request.headers.get("X-TRACER-EXTENSION-KEY")?.trim();

  if (!expectedKey) {
    return NextResponse.json(
      { ok: false, error: "TRACER_EXTENSION_API_KEY is not configured" },
      { status: 503 },
    );
  }

  if (!suppliedKey || suppliedKey !== expectedKey) {
    return NextResponse.json(
      { ok: false, error: "Invalid extension key" },
      { status: 401 },
    );
  }

  try {
    const body = (await request.json()) as {
      market?: Record<string, unknown>;
      supply?: Record<string, unknown>;
    };

    const market = identifiersFromRecord(body.market ?? {});
    const supply = identifiersFromRecord(body.supply ?? {});

    const result = matchProductIdentity({
      market: { ...EMPTY_IDENTIFIERS, ...market, title: String(body.market?.title ?? "") },
      supply: { ...EMPTY_IDENTIFIERS, ...supply, title: String(body.supply?.title ?? "") },
    });

    return NextResponse.json({ ok: true, identity: result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 400 },
    );
  }
}

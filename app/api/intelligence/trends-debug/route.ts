import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const response = await fetch(
    "https://trends.google.com/trending/rss?geo=JP",
    {
      headers: {
        "User-Agent": "TRACER/1.0 Demand Intelligence",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
      cache: "no-store",
    },
  );

  const bytes = await response.arrayBuffer();
  const xml = new TextDecoder("utf-8").decode(bytes);

  const match = xml.match(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/i);

  return NextResponse.json({
    ok: true,
    title: match?.[1] ?? null,
    chars: Array.from(match?.[1] ?? "").map((c) => c.codePointAt(0)),
    bytes: Array.from(new Uint8Array(bytes).slice(0, 200)),
  });
}

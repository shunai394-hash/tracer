import { NextResponse } from "next/server";
import { recordShopFunnelEvent } from "@/lib/shop/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      listingId?: string;
      eventType?: "impression" | "click" | "view" | "add_to_cart" | "checkout" | "purchase";
    };

    if (!body.listingId || !body.eventType) {
      return NextResponse.json({ ok: false, error: "listingId and eventType required" }, { status: 400 });
    }

    await recordShopFunnelEvent({
      listingId: body.listingId,
      eventType: body.eventType,
    });

    return NextResponse.json({ ok: true });
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

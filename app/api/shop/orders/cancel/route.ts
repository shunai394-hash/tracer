import { NextResponse } from "next/server";
import { requestShopOrderCancellation } from "@/lib/shop/cancellation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      orderId?: string;
      email?: string;
      reason?: string;
    };

    if (!body.orderId || !body.email) {
      return NextResponse.json(
        { ok: false, error: "orderId and email are required" },
        { status: 400 },
      );
    }

    const result = await requestShopOrderCancellation({
      orderId: body.orderId,
      customerEmail: body.email,
      reason: body.reason,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 400 },
    );
  }
}

import { NextResponse } from "next/server";
import { placeShopOrder } from "@/lib/shop/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      items?: Array<{ listingId?: string; qty?: number }>;
      customerName?: string;
      customerEmail?: string;
      customerPhone?: string;
      shippingAddress?: string;
      paymentMethod?: "cash_on_delivery" | "bank_transfer";
      notes?: string;
    };

    if (!body.customerName || !body.customerEmail || !body.shippingAddress) {
      return NextResponse.json(
        { ok: false, error: "name, email and address are required" },
        { status: 400 },
      );
    }

    const items = (body.items ?? [])
      .filter((item) => item.listingId && item.qty && item.qty > 0)
      .map((item) => ({
        listingId: String(item.listingId),
        qty: Number(item.qty),
      }));

    const order = await placeShopOrder({
      items,
      customerName: body.customerName,
      customerEmail: body.customerEmail,
      customerPhone: body.customerPhone ?? "",
      shippingAddress: body.shippingAddress,
      paymentMethod: body.paymentMethod ?? "cash_on_delivery",
      notes: body.notes,
    });

    return NextResponse.json({ ok: true, orderId: order.orderId });
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

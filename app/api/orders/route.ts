import { NextResponse } from "next/server";
import {
  createPurchaseOrderFromRecommendation,
  listPurchaseOrders,
  listReorderRecommendations,
} from "@/lib/ordering/store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const [recommendations, orders] = await Promise.all([
      listReorderRecommendations(),
      listPurchaseOrders(),
    ]);
    return NextResponse.json({ ok: true, recommendations, orders });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      recommendationId?: string;
      approved?: boolean;
    };

    if (!body.recommendationId) {
      return NextResponse.json(
        { ok: false, error: "recommendationId is required" },
        { status: 400 },
      );
    }

    const order = await createPurchaseOrderFromRecommendation({
      recommendationId: body.recommendationId,
      approved: body.approved === true,
      approvedBy: body.approved === true ? "user" : null,
    });

    return NextResponse.json({ ok: true, order });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 400 },
    );
  }
}

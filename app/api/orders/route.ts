import { NextResponse } from "next/server";
import {
  createPurchaseOrderFromRecommendation,
  listPurchaseOrders,
  listReorderRecommendations,
} from "@/lib/ordering/store";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

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
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

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

    // A shared automation credential proves the caller is a trusted workflow,
    // not which human administrator approved a purchase. Until a verified
    // admin-session identity is available here, fail closed rather than trust
    // a caller-supplied approval flag or fabricate approvedBy: "user".
    if (body.approved === true) {
      return NextResponse.json(
        { ok: false, error: "human_admin_approval_not_supported" },
        { status: 403 },
      );
    }

    const order = await createPurchaseOrderFromRecommendation({
      recommendationId: body.recommendationId,
      approved: false,
      approvedBy: null,
    });

    return NextResponse.json({ ok: true, order });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 400 },
    );
  }
}

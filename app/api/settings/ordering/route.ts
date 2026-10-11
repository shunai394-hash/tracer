import { NextResponse } from "next/server";
import {
  getOrderingSettings,
  saveOrderingSettings,
} from "@/lib/ordering/store";
import { parseOrderingSettings } from "@/lib/ordering/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    const settings = await getOrderingSettings();
    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const settings = await saveOrderingSettings(
      parseOrderingSettings({
        mode: body.mode,
        daily_order_limit: body.dailyOrderLimit ?? body.daily_order_limit,
        per_product_order_limit:
          body.perProductOrderLimit ?? body.per_product_order_limit,
        monthly_order_budget:
          body.monthlyOrderBudget ?? body.monthly_order_budget,
        category_budgets: body.categoryBudgets ?? body.category_budgets,
        default_lead_time_days:
          body.defaultLeadTimeDays ?? body.default_lead_time_days,
        default_safety_stock:
          body.defaultSafetyStock ?? body.default_safety_stock,
      }),
    );
    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 400 },
    );
  }
}

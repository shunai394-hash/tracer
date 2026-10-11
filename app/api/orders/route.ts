import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig } from "@/lib/config/env";
import { createPurchaseOrderFromRecommendation, listPurchaseOrders, listReorderRecommendations } from "@/lib/ordering/store";
import { verifyAdminRequest } from "@/lib/security/verify-admin-request";

export const runtime = "nodejs";
type VerifiedAdmin = { email: string };

async function requireVerifiedAdmin(request: Request): Promise<
  | { ok: true; admin: VerifiedAdmin }
  | { ok: false; response: ReturnType<typeof NextResponse.json> }
> {
  const result = await verifyAdminRequest(request, {
    getPublicConfig: getSupabasePublicConfig,
    allowedEmails: process.env.TRACER_ADMIN_EMAILS,
    createAuthClient: (url, anonKey, token) => createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }),
  });
  if (!result.ok) {
    return { ok: false, response: NextResponse.json({ ok: false, error: result.error }, { status: result.status }) };
  }
  return { ok: true, admin: result.admin };
}

export async function GET(request: Request) {
  const auth = await requireVerifiedAdmin(request);
  if (!auth.ok) return auth.response;
  try {
    const [recommendations, orders] = await Promise.all([listReorderRecommendations(), listPurchaseOrders()]);
    return NextResponse.json({ ok: true, recommendations, orders }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "order_data_unavailable" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireVerifiedAdmin(request);
  if (!auth.ok) return auth.response;

  let body: { recommendationId?: string; approved?: boolean };
  try {
    body = (await request.json()) as { recommendationId?: string; approved?: boolean };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.recommendationId !== "string" || !body.recommendationId.trim()) {
    return NextResponse.json({ ok: false, error: "recommendationId is required" }, { status: 400 });
  }
  if (body.approved !== undefined && typeof body.approved !== "boolean") {
    return NextResponse.json({ ok: false, error: "approved must be a boolean" }, { status: 400 });
  }

  try {
    const order = await createPurchaseOrderFromRecommendation({
      recommendationId: body.recommendationId.trim(),
      approved: body.approved === true,
      approvedBy: body.approved === true ? auth.admin.email : null,
    });
    return NextResponse.json({ ok: true, order }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "purchase_order_record_failed" }, { status: 400 });
  }
}

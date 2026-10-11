import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig } from "@/lib/config/env";
import { createPurchaseOrderFromRecommendation, listPurchaseOrders, listReorderRecommendations } from "@/lib/ordering/store";

export const runtime = "nodejs";
type VerifiedAdmin = { email: string };

async function requireVerifiedAdmin(request: Request): Promise<
  | { ok: true; admin: VerifiedAdmin }
  | { ok: false; response: ReturnType<typeof NextResponse.json> }
> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return { ok: false, response: NextResponse.json({ ok: false, error: "authentication_required" }, { status: 401 }) };

  const { url, anonKey } = getSupabasePublicConfig();
  if (!url || !anonKey) return { ok: false, response: NextResponse.json({ ok: false, error: "authentication_unavailable" }, { status: 503 }) };

  try {
    const authClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error } = await authClient.auth.getUser(token);
    if (error || !user?.email) return { ok: false, response: NextResponse.json({ ok: false, error: "invalid_authentication" }, { status: 401 }) };

    const allowedEmails = (process.env.TRACER_ADMIN_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
    if (allowedEmails.length === 0 || !allowedEmails.includes(user.email.toLowerCase())) {
      return { ok: false, response: NextResponse.json({ ok: false, error: "admin_access_required" }, { status: 403 }) };
    }
    return { ok: true, admin: { email: user.email } };
  } catch {
    return { ok: false, response: NextResponse.json({ ok: false, error: "authentication_unavailable" }, { status: 503 }) };
  }
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

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabasePublicConfig } from "@/lib/config/env";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!token) return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });

    const { url, anonKey } = getSupabasePublicConfig();
    if (!url || !anonKey) return NextResponse.json({ ok: false, error: "Supabase is not configured" }, { status: 503 });

    const authClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user?.email) return NextResponse.json({ ok: false, error: "Invalid authentication" }, { status: 401 });

    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("shop_orders")
      .select("*")
      .eq("customer_email", user.email)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);

    const orders = (data ?? []).map((row) => {
      const record = row as Record<string, unknown>;
      const total = record.total ?? record.total_amount ?? record.grand_total ?? null;
      return {
        id: String(record.id ?? ""),
        createdAt: record.created_at ? String(record.created_at) : null,
        status: String(record.order_status ?? record.status ?? "unknown"),
        paymentStatus: String(record.payment_status ?? "unknown"),
        total: total === null ? null : Number(total),
        currency: record.currency ? String(record.currency) : null,
        shippingAddress: record.shipping_address ? String(record.shipping_address) : null,
      };
    });

    return NextResponse.json({ ok: true, orders });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

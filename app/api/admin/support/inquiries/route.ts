import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "管理トークンが正しくありません。" }, { status: 401 });
  try {
    const db = createSupabaseAdminClient();
    const status = new URL(request.url).searchParams.get("status");
    let query = db.from("customer_inquiries")
      .select("id,name,email,category,subject,message,status,admin_note,source,created_at,updated_at")
      .order("created_at", { ascending: false }).limit(500);
    if (status && ["new", "in_progress", "resolved", "spam"].includes(status)) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ ok: true, inquiries: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[SUPPORT ADMIN] inquiry read failed", error);
    return NextResponse.json({ ok: false, error: "問い合わせを読み込めませんでした。マイグレーションの適用を確認してください。" }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "管理トークンが正しくありません。" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: "入力内容が不正です。" }, { status: 400 }); }

  const id = typeof body.id === "string" ? body.id : "";
  const status = typeof body.status === "string" ? body.status : "";
  const adminNote = typeof body.admin_note === "string" ? body.admin_note.trim().slice(0, 4000) : "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !["new", "in_progress", "resolved", "spam"].includes(status)) {
    return NextResponse.json({ ok: false, error: "問い合わせIDまたはステータスが不正です。" }, { status: 400 });
  }
  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db.from("customer_inquiries")
      .update({ status, admin_note: adminNote || null })
      .eq("id", id).select("id,status,admin_note,updated_at").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, inquiry: data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[SUPPORT ADMIN] inquiry update failed", error);
    return NextResponse.json({ ok: false, error: "対応状況を保存できませんでした。" }, { status: 503 });
  }
}
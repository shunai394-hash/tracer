import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const categories = ["注文・配送", "返品・返金", "商品について", "決済について", "アカウント", "その他"] as const;
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "入力内容を確認してください。" }, { status: 400 });
  }

  // Honeypot: bots that fill this hidden field are accepted without storing a ticket.
  if (text(body.website, 200)) return NextResponse.json({ ok: true });
  const name = text(body.name, 100);
  const email = text(body.email, 254).toLowerCase();
  const category = text(body.category, 40);
  const subject = text(body.subject, 160);
  const message = text(body.message, 5000);

  if (!name || !email || !subject || !message || !categories.includes(category as typeof categories[number])) {
    return NextResponse.json({ ok: false, error: "必須項目を入力してください。" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: "メールアドレスを確認してください。" }, { status: 400 });
  }
  if (message.length < 10) return NextResponse.json({ ok: false, error: "お問い合わせ内容を10文字以上入力してください。" }, { status: 400 });

  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db.from("customer_inquiries").insert({
      name, email, category, subject, message, source: "contact_form",
    }).select("id").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, ticketId: data.id }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[SUPPORT CONTACT] inquiry persistence failed", error);
    return NextResponse.json({ ok: false, error: "送信を保存できませんでした。時間をおいて再度お試しください。" }, { status: 503 });
  }
}
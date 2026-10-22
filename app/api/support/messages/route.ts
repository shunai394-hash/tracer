import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
export const runtime = "nodejs";
export async function POST(request: Request) {
 try {
  const b = await request.json() as Record<string,unknown>;
  const v = (x:unknown,n:number) => typeof x === "string" ? x.trim().slice(0,n) : "";
  if (v(b.website,200)) return NextResponse.json({ok:true});
  const name=v(b.name,100), email=v(b.email,254).toLowerCase(), subject=v(b.subject,180), message=v(b.message,5000);
  const categories=["注文・配送","返品・返金","商品について","決済について","アカウント","その他"];
  const category=v(b.category,60);
  if(!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || subject.length<2 || message.length<10)
   return NextResponse.json({ok:false,error:"入力内容を確認してください。本文は10文字以上必要です。"},{status:400});
  const {error}=await createSupabaseAdminClient().from("customer_inquiries").insert({name,email,subject,message,category:categories.includes(category)?category:"その他",status:"new",source:"contact_form"});
  if(error) throw error;
  return NextResponse.json({ok:true},{status:201});
 } catch(e) { console.error("[SUPPORT INSERT]",e instanceof Error?e.message:"unknown"); return NextResponse.json({ok:false,error:"送信できませんでした。時間をおいて再度お試しください。"},{status:503}); }
}
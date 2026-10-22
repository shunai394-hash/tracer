import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
export const runtime="nodejs"; export const dynamic="force-dynamic";
const statuses=["new","in_progress","resolved","spam"];
async function guard(req:Request){
 const h=req.headers.get("authorization")||"", token=h.startsWith("Bearer ")?h.slice(7).trim():"";
 if(!token)return NextResponse.json({ok:false,error:"ログインしてください。"},{status:401});
 const allow=(process.env.TRACER_ADMIN_EMAILS||"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
 if(!allow.length)return NextResponse.json({ok:false,error:"TRACER_ADMIN_EMAILS が未設定です。"},{status:503});
 const {data,error}=await createSupabaseServerClient().auth.getUser(token);
 if(error||!data.user?.email||!allow.includes(data.user.email.toLowerCase()))return NextResponse.json({ok:false,error:"管理者権限がありません。"},{status:403});
 return null;
}
export async function GET(req:Request){
 const denied=await guard(req);if(denied)return denied;
 try{const u=new URL(req.url),s=u.searchParams.get("status");let q=createSupabaseAdminClient().from("customer_inquiries").select("id,name,email,category,subject,message,status,admin_note,created_at,updated_at").order("created_at",{ascending:false}).limit(200);if(s&&statuses.includes(s))q=q.eq("status",s);const {data,error}=await q;if(error)throw error;return NextResponse.json({ok:true,messages:data||[]});}
 catch(e){console.error("[ADMIN SUPPORT]",e instanceof Error?e.message:"unknown");return NextResponse.json({ok:false,error:"取得できませんでした。"},{status:503});}
}
export async function PATCH(req:Request){
 const denied=await guard(req);if(denied)return denied;
 const b=await req.json().catch(()=>({})) as {id?:unknown;status?:unknown;adminNote?:unknown};
 if(typeof b.id!=="string"||!/^[0-9a-f-]{36}$/i.test(b.id)||typeof b.status!=="string"||!statuses.includes(b.status))return NextResponse.json({ok:false,error:"更新内容が正しくありません。"},{status:400});
 const {error}=await createSupabaseAdminClient().from("customer_inquiries").update({status:b.status,admin_note:typeof b.adminNote==="string"?b.adminNote.slice(0,4000)||null:null,updated_at:new Date().toISOString()}).eq("id",b.id);
 if(error){console.error("[ADMIN SUPPORT UPDATE]",error.message);return NextResponse.json({ok:false,error:"更新できませんでした。"},{status:503});}
 return NextResponse.json({ok:true});
}
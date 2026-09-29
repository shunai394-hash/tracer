import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireCronAuth } from "@/lib/security/cron-auth";
export const runtime="nodejs";
export async function POST(request:Request){
 const authError=requireCronAuth(request); if(authError)return authError;
 const body=await request.json().catch(()=>null); const items=Array.isArray(body?.items)?body.items:[];
 if(!items.length)return NextResponse.json({ok:false,error:"items required"},{status:400});
 const db=createSupabaseAdminClient(); let upserted=0,rejected=0;
 for(const x of items){
  const cost=Number(x.cost),shipping=Number(x.shippingCost??0),handling=Number(x.handlingCost??0),sale=Number(x.salePrice),inventory=Math.max(0,Number(x.inventory));
  if(!x.tracerSku||!x.title||!Number.isFinite(cost)||!Number.isFinite(sale)||cost<0||sale<=0){rejected++;continue}
  const orderable=inventory>0&&sale>cost+shipping+handling;
  const {data,error}=await db.from("tracer_supply_catalog").upsert({tracer_sku:x.tracerSku,title:x.title,brand:x.brand??null,category:x.category??null,description:x.description??null,image_url:x.imageUrl??null,status:orderable?"ready":"draft",cost,shipping_cost:shipping,handling_cost:handling,sale_price:sale,inventory,lead_time_days:x.leadTimeDays??null,tracking_available:Boolean(x.trackingAvailable),orderable,source_type:"internal",source_ref:x.sourceRef??null,updated_at:new Date().toISOString()},{onConflict:"tracer_sku"}).select("id").single();
  if(error||!data){rejected++;continue} upserted++;
  for(const v of Array.isArray(x.variants)?x.variants:[]) await db.from("tracer_supply_variants").upsert({catalog_id:data.id,variant_sku:v.variantSku,title:v.title??null,barcode:v.barcode??null,attributes:v.attributes??{},cost:Number.isFinite(Number(v.cost))?Number(v.cost):cost,inventory:Math.max(0,Number(v.inventory??inventory)),orderable:Number(v.inventory??inventory)>0,updated_at:new Date().toISOString()},{onConflict:"variant_sku"});
 }
 return NextResponse.json({ok:true,upserted,rejected});
}
export async function GET(request:Request){
 const authError=requireCronAuth(request); if(authError)return authError;
 const {data,error}=await createSupabaseAdminClient().from("tracer_supply_catalog").select("id,tracer_sku,title,brand,category,cost,shipping_cost,handling_cost,sale_price,currency,inventory,tracking_available,orderable,status,source_type,source_ref,updated_at").order("updated_at",{ascending:false}).limit(200);
 if(error)return NextResponse.json({ok:false,error:error.message},{status:500}); return NextResponse.json({ok:true,items:data??[]});
}
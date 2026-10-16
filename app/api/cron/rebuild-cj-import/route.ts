import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { upsertSupplierOffer, recalculatePrice } from "@/lib/commerce/core";
import { searchCJProducts, getCJProductDetail, fetchCJProductVariants, fetchCJVariantByVid, fetchCJVariantStock, calculateCJFreight } from "@/lib/sources/cj";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { localizeProductTitle, isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";

export const runtime = "nodejs";
export const maxDuration = 300;

function titleJa(title: string, type?: string | null): string {
  const raw = (title + " " + (type ?? "")).toLowerCase();
  const rules: Array<[RegExp,string]> = [
    [/women.*handbag|handbag.*women|purse|crossbody|shoulder bag|tote bag/, "レディースハンドバッグ"],
    [/hair clip|hair claw|headband|hair band/, "レディースヘアアクセサリー"],
    [/makeup brush|cosmetic brush|beauty tool|face roller/, "美容ツール"],
    [/earring|necklace|bracelet/, "アクセサリー"],
    [/phone case|mobile phone case/, "スマートフォンケース"],
  ];
  const result = rules.find(([pattern]) => pattern.test(raw))?.[1] ?? localizeProductTitle(title, type) ?? "";
  return isJapaneseProductTitle(result) ? result : "";
}
function variantJa(name: unknown): string {
  const source=String(name??"").toLowerCase();
  const colors:Array<[RegExp,string]>=[[/black/,"ブラック"],[/white/,"ホワイト"],[/pink/,"ピンク"],[/blue/,"ブルー"],[/green/,"グリーン"],[/red/,"レッド"],[/purple/,"パープル"],[/beige/,"ベージュ"],[/brown/,"ブラウン"],[/gray|grey/,"グレー"],[/silver/,"シルバー"],[/gold/,"ゴールド"]];
  const matches=colors.filter(([p])=>p.test(source)).map(([,v])=>v);
  return matches.length ? "（"+[...new Set(matches)].join("・")+"）" : "（標準）";
}

export async function GET(request: Request) {
  const authError=await requireAutomationAuth(request);
  if(authError) return authError;
  const params=new URL(request.url).searchParams;
  const defaults=["women handbag","beauty tools","hair accessories women","phone case"];
  const query=(params.get("q")||defaults[Math.floor(Date.now()/1_800_000)%defaults.length]).trim().slice(0,100);
  const page=Math.min(1000,Math.max(1,Number(params.get("page")||1)));
  const limit=Math.min(10,Math.max(1,Number(params.get("limit")||3)));
  const fx=await getObservedUsdToJpyRate();
  if(!fx||!Number.isFinite(fx.rate)||fx.rate<=0) return NextResponse.json({ok:false,error:"usd_jpy_rate_unavailable",imported:0},{status:503});
  const stats={searched:0,products:0,variants:0,priced:0,skipped:0,errors:[] as string[]};
  try {
    const found=await searchCJProducts(query,{page,size:Math.min(20,limit*2)});
    stats.searched=found.products.length;
    for(const candidate of found.products.slice(0,limit)) {
      try {
        const initial=await getCJProductDetail(candidate.id);
        if(!initial){stats.skipped++;continue;}
        const variants=await fetchCJProductVariants(candidate.id);
        if(!variants.length){stats.skipped++;continue;}
        for(const listed of variants.slice(0,5)) {
          try {
            if(!listed.vid){stats.skipped++;continue;}
            const exact=await fetchCJVariantByVid(listed.vid);
            const productId=String(exact?.productId??"").trim();
            if(!exact||String(exact.vid)!==String(listed.vid)||!productId){stats.skipped++;stats.errors.push("exact_variant_unresolved:"+listed.vid);continue;}
            const detail=productId===candidate.id?initial:await getCJProductDetail(productId);
            const localized=detail?titleJa(detail.title,detail.productType):"";
            const usd=Number(exact.sellPrice);
            if(!detail||!localized||!Number.isFinite(usd)||usd<=0){stats.skipped++;continue;}
            const [stockR,freightR]=await Promise.allSettled([fetchCJVariantStock(exact.vid),calculateCJFreight(exact.vid,{startCountryCode:"CN",endCountryCode:"JP",quantity:1})]);
            const stock=stockR.status==="fulfilled"?Number(stockR.value):Number.NaN;
            const freight=freightR.status==="fulfilled"?Number(freightR.value):Number.NaN;
            const verified=Number.isFinite(stock)&&stock>0&&Number.isFinite(freight)&&freight>=0;
            const saved=await upsertSupplierOffer({
              sourceKey:"cj:"+productId,
              titleJa:localized,
              descriptionJa:localized+"。仕入先の仕様・送料・在庫は注文時にも再確認します。",
              category:detail.productType??null,
              imageUrl:detail.imageUrl??null,
              sourceUrl:"https://cjdropshipping.com/product/"+encodeURIComponent(productId),
              sourceVariantKey:"cj:"+productId+":"+String(exact.vid),
              variantTitleJa:variantJa(exact.nameEn),
              sku:exact.sku??null,
              metadata:{sourceTitle:detail.title,sourceProductType:detail.productType??null},
              attributes:{sourceVariantName:exact.nameEn??null,barcode:exact.barcode??null},
              offer:{
                supplierCode:"cj",supplierProductId:productId,supplierVariantId:String(exact.vid),
                supplierUrl:"https://cjdropshipping.com/product/"+encodeURIComponent(productId),
                currency:"USD",unitCost:usd,shippingCost:Number.isFinite(freight)?Math.max(0,freight):0,
                inventory:Number.isFinite(stock)?Math.max(0,Math.floor(stock)):0,shipTo:"JP",
                trackingSupported:verified,sourceStatus:verified?"verified":"discovered",
                lastCheckedAt:new Date().toISOString(),
                rawData:{query,page,fxRate:fx.rate,stockKnown:Number.isFinite(stock),shippingKnown:Number.isFinite(freight),variantName:exact.nameEn??null}
              }
            });
            stats.variants++;
            if(verified) {
              await recalculatePrice({variantId:saved.variantId,offerId:saved.offerId,exchangeRateToJpy:fx.rate,feeRate:0.1,targetMarginRate:0.2});
              stats.priced++;
            } else stats.skipped++;
          } catch(e) {stats.errors.push("variant:"+String(listed.vid)+":"+ (e instanceof Error?e.message:String(e)).slice(0,150));}
        }
        stats.products++;
      } catch(e) {stats.errors.push("product:"+candidate.id+":"+(e instanceof Error?e.message:String(e)).slice(0,150));}
    }
    return NextResponse.json({ok:stats.errors.length===0,query,page,fxRate:fx.rate,stats},{status:stats.errors.length?207:200});
  } catch(e) {
    return NextResponse.json({ok:false,query,page,stats,error:e instanceof Error?e.message:String(e)},{status:502});
  }
}

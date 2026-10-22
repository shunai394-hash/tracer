import { NextResponse } from "next/server";
export const runtime="nodejs";
const faqs=[
 {keys:["配送","届","追跡","発送"],answer:"配送状況は商品・注文ごとに異なります。注文番号を添えてお問い合わせください。",href:"/contact",label:"配送について問い合わせる"},
 {keys:["返品","交換","返金","キャンセル"],answer:"返品・交換は返品ポリシーをご確認ください。注文固有のご相談はお問い合わせフォームへどうぞ。",href:"/returns",label:"返品・交換ポリシー"},
 {keys:["支払","決済","カード"],answer:"ご利用可能な支払方法は購入画面をご確認ください。カード番号やパスワードは問い合わせ本文に書かないでください。",href:"/contact",label:"問い合わせる"},
 {keys:["個人情報","プライバシー","削除"],answer:"個人情報の取扱いはプライバシーポリシーをご確認ください。確認・削除等の相談もフォームで受け付けます。",href:"/privacy",label:"プライバシーポリシー"},
 {keys:["規約","規定","ルール","利用"],answer:"本サービスの利用条件は利用規約をご確認ください。",href:"/terms",label:"利用規約"},
 {keys:["特商法","事業者","会社","住所","電話"],answer:"事業者情報と販売条件はこちらをご確認ください。",href:"/legal",label:"特商法に基づく表記"}
];
export async function POST(request:Request){
 const b=await request.json().catch(()=>({})) as {message?:unknown};
 const m=typeof b.message==="string"?b.message.trim().slice(0,500):"";
 if(!m)return NextResponse.json({ok:false,error:"質問を入力してください。"},{status:400});
 const found=faqs.find(f=>f.keys.some(k=>m.toLowerCase().includes(k)));
 return NextResponse.json({ok:true,answer:found?.answer??"このチャットでは確実な情報を確認できませんでした。推測で回答せず、お問い合わせフォームをご案内します。",href:found?.href??"/contact",label:found?.label??"お問い合わせフォーム"});
}
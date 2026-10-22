import { NextResponse } from "next/server";
import { generateStructuredJson, isGeminiConfigured } from "@/lib/ai/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const faq = [
  { topic: "配送・追跡", keywords: ["配送", "いつ届", "発送", "追跡"], answer: "配送予定や追跡番号は、注文確認メールまたはマイページでご確認ください。表示されない場合は、お問い合わせフォームで注文番号を添えてご連絡ください。" },
  { topic: "返品・返金", keywords: ["返品", "返金", "交換", "キャンセル"], answer: "返品・返金は商品の状態と注文条件により対応が異なります。破損・誤配送は注文番号と写真をご用意のうえお問い合わせください。詳細は返品・返金ポリシーをご確認ください。" },
  { topic: "お支払い", keywords: ["支払", "決済", "カード", "請求"], answer: "利用可能な支払い方法はご注文画面に表示される内容をご確認ください。二重請求などの疑いがある場合は、注文番号と請求日時を添えてお問い合わせください。" },
  { topic: "商品について", keywords: ["商品", "サイズ", "色", "素材", "在庫"], answer: "商品ページに記載された仕様・価格・在庫をご確認ください。記載がない点は商品名とURLを添えてお問い合わせください。" },
  { topic: "個人情報", keywords: ["個人情報", "プライバシー", "データ"], answer: "個人情報の取り扱いはプライバシーポリシーをご確認ください。データに関するご要望はお問い合わせフォームからお送りいただけます。" },
];

export async function POST(request: Request) {
  let body: { message?: unknown };
  try { body = await request.json() as { message?: unknown }; }
  catch { return NextResponse.json({ ok: false, error: "質問を入力してください。" }, { status: 400 }); }
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 1000) : "";
  if (!message) return NextResponse.json({ ok: false, error: "質問を入力してください。" }, { status: 400 });

  const fallback = faq.find((item) => item.keywords.some((keyword) => message.includes(keyword)));
  if (!isGeminiConfigured()) {
    return NextResponse.json({ ok: true, topic: fallback?.topic ?? "担当窓口へのお問い合わせ", answer: fallback?.answer ?? "この質問はチャットで回答を確定できませんでした。お問い合わせフォームから担当者へご連絡ください。", mode: "faq_fallback" });
  }

  try {
    const result = await generateStructuredJson<{ topic?: string; answer?: string; needsHuman?: boolean }>({
      timeoutMs: 8000,
      systemInstruction: "あなたは日本のオンラインストアTRACERのカスタマーサポートAIです。回答は必ず日本語で、丁寧かつ簡潔にしてください。参照できるFAQの範囲内だけで回答し、配送日、在庫、注文状態、返金可否、返金完了、決済状況を推測してはいけません。注文や顧客の個別データにはアクセスできません。パスワード、カード番号、認証コードなどの秘密情報を求めてはいけません。個別確認が必要ならお問い合わせフォームを案内し、needsHuman=trueにしてください。JSONのみ返し、topic, answer, needsHumanを含めてください。",
      prompt: JSON.stringify({ question: message, publicFaq: faq, policies: { returns: "/policies/returns", shipping: "/policies/shipping", terms: "/terms", privacy: "/privacy", contact: "/contact" } }),
    });
    const answer = typeof result.answer === "string" ? result.answer.trim().slice(0, 2000) : "";
    if (!answer) throw new Error("empty_support_answer");
    return NextResponse.json({ ok: true, topic: typeof result.topic === "string" ? result.topic.slice(0, 80) : "サポート", answer, needsHuman: result.needsHuman === true, mode: "ai" });
  } catch (error) {
    console.error("[TRACER SUPPORT AI]", error instanceof Error ? error.message : "unknown_error");
    return NextResponse.json({ ok: true, topic: fallback?.topic ?? "担当窓口へのお問い合わせ", answer: fallback?.answer ?? "正確なご案内のため、こちらでは回答を確定できませんでした。お問い合わせフォームから担当者へご連絡ください。", needsHuman: !fallback, mode: "faq_fallback" });
  }
}
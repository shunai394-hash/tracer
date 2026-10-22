"use client";

import Link from "next/link";
import { useState } from "react";

const answers: Array<{ terms: string[]; title: string; answer: string }> = [
  { terms: ["配送", "いつ届", "発送", "追跡"], title: "配送・追跡", answer: "配送予定や追跡番号は、注文確認メールまたはマイページでご確認ください。表示されない場合は、お問い合わせフォームで注文番号を添えてご連絡ください。" },
  { terms: ["返品", "返金", "交換", "キャンセル"], title: "返品・返金", answer: "返品・返金は商品の状態と注文条件により対応が異なります。商品到着時の破損・誤配送は、注文番号と写真をご用意のうえお問い合わせください。詳細は返品・返金ポリシーをご確認ください。" },
  { terms: ["支払", "決済", "カード", "請求"], title: "お支払い", answer: "決済の可否や利用可能な支払い方法は、ご注文画面に表示される内容をご確認ください。二重請求などの疑いがある場合は、注文番号と請求日時を添えてお問い合わせください。" },
  { terms: ["商品", "サイズ", "色", "素材", "在庫"], title: "商品について", answer: "商品ページに記載された仕様・価格・在庫をご確認ください。確認したい点が記載されていない場合は、商品名とURLを添えてお問い合わせください。" },
  { terms: ["個人情報", "プライバシー", "データ"], title: "個人情報", answer: "個人情報の取り扱いはプライバシーポリシーをご確認ください。データに関するご要望はお問い合わせフォームからお送りいただけます。" },
];

export function SupportChat() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ title: string; answer: string } | null>(null);
  function ask(value: string) {
    const text = value.trim();
    if (!text) return;
    const match = answers.find((item) => item.terms.some((term) => text.includes(term)));
    setAnswer(match ? { title: match.title, answer: match.answer } : {
      title: "担当窓口へのお問い合わせ",
      answer: "このチャットでは回答を確定できませんでした。内容を担当者が確認できるよう、お問い合わせフォームからお送りください。",
    });
    setQuestion(text);
  }
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-900 text-lg text-white">?</div>
        <div><h2 className="font-semibold">TRACER サポートアシスタント</h2><p className="mt-1 text-xs text-neutral-500">よくある質問からご案内します</p></div>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {["配送状況を確認したい", "返品・返金について", "支払いについて", "商品について"].map((item) => (
          <button key={item} type="button" onClick={() => ask(item)} className="rounded-full border border-neutral-200 px-3 py-2 text-sm hover:border-neutral-500">{item}</button>
        ))}
      </div>
      <form className="mt-5 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); ask(question); }}>
        <label className="sr-only" htmlFor="support-question">お問い合わせ内容</label>
        <input id="support-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="お困りの内容を入力してください" className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-4 py-3 text-sm outline-none focus:border-neutral-900" />
        <button className="rounded-lg bg-neutral-900 px-5 py-3 text-sm font-semibold text-white hover:bg-neutral-700">回答を見る</button>
      </form>
      {answer ? <div className="mt-5 rounded-xl bg-neutral-50 p-4" aria-live="polite"><h3 className="font-semibold">{answer.title}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-700">{answer.answer}</p><Link href="/contact" className="mt-4 inline-flex rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white">担当者に問い合わせる</Link></div> : null}
      <p className="mt-4 text-xs leading-5 text-neutral-500">このアシスタントはFAQに基づく案内です。個別注文の照会や返金処理は行いません。解決しない場合はお問い合わせフォームをご利用ください。</p>
    </section>
  );
}
"use client";

import Link from "next/link";
import { useState } from "react";

type SupportAnswer = { title: string; answer: string; needsHuman?: boolean };

export function SupportChat() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<SupportAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function ask(value: string) {
    const message = value.trim();
    if (!message || busy) return;
    setQuestion(message);
    setBusy(true);
    setError("");
    setAnswer(null);
    try {
      const response = await fetch("/api/support/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const payload = await response.json() as { ok: boolean; topic?: string; answer?: string; needsHuman?: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "回答を取得できませんでした。");
      setAnswer({ title: payload.topic || "サポート", answer: payload.answer || "お問い合わせフォームから担当者へご連絡ください。", needsHuman: payload.needsHuman });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "回答を取得できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-900 text-lg text-white">?</div>
        <div><h2 className="font-semibold">TRACER AIチャットサポート</h2><p className="mt-1 text-xs text-neutral-500">よくある質問をもとにご案内します</p></div>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {["配送状況を確認したい", "返品・返金について", "支払いについて", "商品について"].map((item) => (
          <button key={item} type="button" disabled={busy} onClick={() => void ask(item)} className="rounded-full border border-neutral-200 px-3 py-2 text-sm hover:border-neutral-500 disabled:opacity-50">{item}</button>
        ))}
      </div>
      <form className="mt-5 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void ask(question); }}>
        <label className="sr-only" htmlFor="support-question">お問い合わせ内容</label>
        <input id="support-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="お困りの内容を入力してください" maxLength={1000} className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-4 py-3 text-sm outline-none focus:border-neutral-900" />
        <button disabled={busy || !question.trim()} className="rounded-lg bg-neutral-900 px-5 py-3 text-sm font-semibold text-white hover:bg-neutral-700 disabled:opacity-50">{busy ? "回答を作成中…" : "回答を見る"}</button>
      </form>
      {error ? <p role="alert" className="mt-4 text-sm text-red-700">{error}</p> : null}
      {answer ? <div className="mt-5 rounded-xl bg-neutral-50 p-4" aria-live="polite"><h3 className="font-semibold">{answer.title}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-700">{answer.answer}</p>{answer.needsHuman ? <p className="mt-2 text-xs text-neutral-500">担当者による確認が必要です。</p> : null}<Link href="/contact" className="mt-4 inline-flex rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white">担当者に問い合わせる</Link></div> : null}
      <p className="mt-4 text-xs leading-5 text-neutral-500">AIはFAQに基づいて案内しますが、個別注文の照会や返金処理は行いません。パスワードやカード番号などの秘密情報は入力しないでください。解決しない場合はお問い合わせフォームをご利用ください。</p>
    </section>
  );
}
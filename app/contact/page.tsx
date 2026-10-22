"use client";

import Link from "next/link";
import { useState } from "react";

const categories = ["注文・配送", "返品・返金", "商品について", "決済について", "アカウント", "その他"];

export default function ContactPage() {
  const [form, setForm] = useState({ name: "", email: "", category: "その他", subject: "", message: "", website: "" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; ticketId?: string } | null>(null);
  function update(key: keyof typeof form, value: string) { setForm((current) => ({ ...current, [key]: value })); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setResult(null);
    try {
      const response = await fetch("/api/support/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const payload = await response.json() as { ok: boolean; error?: string; ticketId?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "送信できませんでした。");
      setResult({ ok: true, message: "お問い合わせを受け付けました。受付番号を控えてください。", ticketId: payload.ticketId });
      setForm({ name: "", email: "", category: "その他", subject: "", message: "", website: "" });
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : "送信できませんでした。" });
    } finally { setBusy(false); }
  }
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10 sm:py-16">
      <Link href="/support" className="text-sm text-neutral-500 hover:text-neutral-900">← サポートセンター</Link>
      <h1 className="mt-4 text-3xl font-bold">お問い合わせ</h1>
      <p className="mt-3 text-sm leading-6 text-neutral-600">送信内容はサポート担当者が確認できる管理用受信箱に保存されます。注文に関するお問い合わせは、本文に注文番号を記載してください。</p>
      {result ? <div role={result.ok ? "status" : "alert"} className={`mt-6 rounded-lg border p-4 text-sm ${result.ok ? "border-green-200 bg-green-50 text-green-900" : "border-red-200 bg-red-50 text-red-900"}`}>{result.message}{result.ticketId ? <p className="mt-2 font-mono">受付番号: {result.ticketId}</p> : null}</div> : null}
      <form onSubmit={submit} className="mt-8 space-y-5">
        <div className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden" aria-hidden="true"><label htmlFor="website">この欄は入力しないでください</label><input id="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => update("website", e.target.value)} /></div>
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block text-sm font-medium">お名前 <span className="text-red-600">*</span><input required maxLength={100} value={form.name} onChange={(e) => update("name", e.target.value)} className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-3 font-normal outline-none focus:border-neutral-900" /></label>
          <label className="block text-sm font-medium">メールアドレス <span className="text-red-600">*</span><input required type="email" maxLength={254} value={form.email} onChange={(e) => update("email", e.target.value)} className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-3 font-normal outline-none focus:border-neutral-900" /></label>
        </div>
        <label className="block text-sm font-medium">お問い合わせ種別<select value={form.category} onChange={(e) => update("category", e.target.value)} className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-3 font-normal">{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="block text-sm font-medium">件名 <span className="text-red-600">*</span><input required maxLength={160} value={form.subject} onChange={(e) => update("subject", e.target.value)} className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-3 font-normal outline-none focus:border-neutral-900" /></label>
        <label className="block text-sm font-medium">お問い合わせ内容 <span className="text-red-600">*</span><textarea required minLength={10} maxLength={5000} rows={7} value={form.message} onChange={(e) => update("message", e.target.value)} className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-3 font-normal outline-none focus:border-neutral-900" /></label>
        <p className="text-xs leading-5 text-neutral-500">送信された情報はお問い合わせ対応のために使用します。詳しくは<Link href="/privacy" className="underline">プライバシーポリシー</Link>をご確認ください。</p>
        <button disabled={busy} className="w-full rounded-lg bg-neutral-900 px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? "送信中…" : "お問い合わせを送信"}</button>
      </form>
    </main>
  );
}
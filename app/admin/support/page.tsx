"use client";

import { useCallback, useState } from "react";

type Inquiry = {
  id: string;
  name: string;
  email: string;
  category: string;
  subject: string;
  message: string;
  status: "new" | "in_progress" | "resolved" | "spam";
  admin_note: string | null;
  source: string;
  created_at: string;
  updated_at: string;
};

const statusLabels: Record<Inquiry["status"], string> = {
  new: "未対応",
  in_progress: "対応中",
  resolved: "対応済み",
  spam: "迷惑メール",
};

export default function AdminSupportPage() {
  const [token, setToken] = useState("");
  const [items, setItems] = useState<Inquiry[]>([]);
  const [filter, setFilter] = useState("all");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!token.trim()) {
      setError("Vercel環境変数 TRACER_ADMIN_TOKEN に設定した管理トークンを入力してください。");
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/support/inquiries" + (filter === "all" ? "" : "?status=" + encodeURIComponent(filter)), {
        headers: { Authorization: "Bearer " + token.trim() },
        cache: "no-store",
      });
      const payload = await response.json() as { ok: boolean; inquiries?: Inquiry[]; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "お問い合わせを取得できませんでした。");
      const next = payload.inquiries ?? [];
      setItems(next);
      setNotes(Object.fromEntries(next.map((item) => [item.id, item.admin_note ?? ""])));
      setNotice(next.length + "件のお問い合わせを読み込みました。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "取得できませんでした。");
    } finally {
      setLoading(false);
    }
  }, [filter, token]);

  async function update(item: Inquiry, status: Inquiry["status"]) {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/support/inquiries", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token.trim() },
        body: JSON.stringify({ id: item.id, status, admin_note: notes[item.id] ?? "" }),
      });
      const payload = await response.json() as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "更新できませんでした。");
      setNotice("対応状況と管理メモを保存しました。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更新できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-10 sm:px-8 sm:py-14">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">TRACER / ADMIN</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">お問い合わせ管理</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-600">お客様から送信された問い合わせを確認し、対応状況と内部メモを管理します。管理トークンはこの画面のメモリ内だけで使い、保存しません。</p>

      <section className="mt-7 rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
        <label className="block text-sm font-medium">管理トークン
          <input type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} className="mt-2 w-full rounded-md border border-neutral-300 px-3 py-3 font-normal" placeholder="TRACER_ADMIN_TOKEN" />
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="text-sm">状態
            <select value={filter} onChange={(event) => setFilter(event.target.value)} className="ml-2 rounded-md border border-neutral-300 bg-white px-3 py-2">
              <option value="all">すべて</option><option value="new">未対応</option><option value="in_progress">対応中</option><option value="resolved">対応済み</option><option value="spam">迷惑メール</option>
            </select>
          </label>
          <button type="button" onClick={() => void load()} disabled={loading || !token.trim()} className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{loading ? "処理中…" : "お問い合わせを読み込む"}</button>
          <span className="text-sm text-neutral-500">{items.length}件</span>
        </div>
      </section>

      {error ? <p role="alert" className="mt-5 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p> : null}
      {notice ? <p role="status" className="mt-5 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{notice}</p> : null}

      {items.length === 0 && !loading ? <div className="mt-7 rounded-xl border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">問い合わせを読み込むと、ここに一覧が表示されます。</div> : null}
      <div className="mt-6 space-y-4">
        {items.map((item) => (
          <article key={item.id} className="rounded-xl border border-neutral-200 bg-white p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><p className="text-xs text-neutral-500">{new Date(item.created_at).toLocaleString("ja-JP")} · {item.category} · {item.source}</p><h2 className="mt-2 text-lg font-semibold">{item.subject}</h2><p className="mt-1 text-sm text-neutral-700">{item.name} · <a href={"mailto:" + item.email} className="underline">{item.email}</a></p></div>
              <span className="rounded-full border border-neutral-300 px-3 py-1 text-xs">{statusLabels[item.status]}</span>
            </div>
            <p className="mt-5 whitespace-pre-wrap break-words rounded-lg bg-neutral-50 p-4 text-sm leading-6">{item.message}</p>
            <label className="mt-4 block text-sm font-medium">管理メモ<textarea value={notes[item.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} maxLength={4000} rows={3} className="mt-2 w-full rounded-md border border-neutral-300 px-3 py-2 font-normal" /></label>
            <div className="mt-4 flex flex-wrap gap-2">{(["new", "in_progress", "resolved", "spam"] as const).map((status) => <button key={status} type="button" disabled={loading} onClick={() => void update(item, status)} className={"rounded-md border px-3 py-2 text-xs disabled:opacity-40 " + (item.status === status ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 hover:border-neutral-700")}>{statusLabels[status]}</button>)}</div>
          </article>
        ))}
      </div>
    </main>
  );
}

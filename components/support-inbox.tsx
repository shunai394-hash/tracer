"use client";

import { useState } from "react";

type Inquiry = { id: string; name: string; email: string; category: string; subject: string; message: string; status: string; admin_note: string | null; created_at: string };

const labels: Record<string, string> = { new: "未対応", in_progress: "対応中", resolved: "解決済み", spam: "迷惑メール" };

export function SupportInbox() {
  const [token, setToken] = useState("");
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [selected, setSelected] = useState<Inquiry | null>(null);
  const [statusFilter, setStatusFilter] = useState("new");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/admin/support/inquiries?status=${encodeURIComponent(statusFilter)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const data = await response.json() as { ok: boolean; error?: string; inquiries?: Inquiry[] };
      if (!response.ok || !data.ok) throw new Error(data.error || "読み込みに失敗しました。");
      setInquiries(data.inquiries ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "読み込みに失敗しました。"); }
    finally { setBusy(false); }
  }

  async function save(status: string) {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/support/inquiries", { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ id: selected.id, status, admin_note: note }) });
      const data = await response.json() as { ok: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || "保存に失敗しました。");
      await load(); setSelected(null);
    } catch (e) { setError(e instanceof Error ? e.message : "保存に失敗しました。"); }
    finally { setBusy(false); }
  }

  return <div className="space-y-6">
    <section className="rounded-xl border border-neutral-200 p-5">
      <h2 className="font-semibold">管理者認証</h2><p className="mt-2 text-sm text-neutral-600">Vercel の TRACER_ADMIN_TOKEN に設定した値を入力してください。トークンはこの画面では保存しません。</p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row"><input type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="管理トークン" className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm" /><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm">{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button onClick={load} disabled={!token || busy} className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "処理中…" : "問い合わせを読み込む"}</button></div>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
    </section>
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section className="space-y-3"><h2 className="font-semibold">受信一覧 <span className="text-sm font-normal text-neutral-500">{inquiries.length}件</span></h2>{inquiries.length === 0 ? <p className="rounded-lg border border-dashed border-neutral-300 p-5 text-sm text-neutral-500">問い合わせがありません。管理トークンを入力して読み込んでください。</p> : inquiries.map((item) => <button key={item.id} onClick={() => { setSelected(item); setNote(item.admin_note ?? ""); }} className={`block w-full rounded-lg border p-4 text-left ${selected?.id === item.id ? "border-neutral-900 bg-neutral-50" : "border-neutral-200 hover:border-neutral-400"}`}><div className="flex items-start justify-between gap-2"><span className="font-medium">{item.subject}</span><span className="shrink-0 text-xs text-neutral-500">{labels[item.status] ?? item.status}</span></div><p className="mt-1 text-sm text-neutral-600">{item.name} · {item.category}</p><p className="mt-1 text-xs text-neutral-500">{new Date(item.created_at).toLocaleString("ja-JP")}</p></button>)}</section>
      <section className="rounded-xl border border-neutral-200 p-5">{selected ? <><h2 className="text-lg font-semibold">{selected.subject}</h2><p className="mt-2 text-sm text-neutral-600">{selected.name} · <a className="underline" href={`mailto:${selected.email}`}>{selected.email}</a></p><p className="mt-4 whitespace-pre-wrap text-sm leading-6">{selected.message}</p><label className="mt-5 block text-sm font-medium">管理メモ<textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} className="mt-2 w-full rounded-lg border border-neutral-300 p-3 text-sm" /></label><div className="mt-4 flex flex-wrap gap-2">{Object.entries(labels).filter(([key]) => key !== selected.status).map(([key, label]) => <button key={key} disabled={busy} onClick={() => save(key)} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm hover:border-neutral-900 disabled:opacity-50">{label}に変更</button>)}</div></> : <p className="text-sm text-neutral-500">左の問い合わせを選択すると、内容と対応ステータスを確認・更新できます。</p>}</section>
    </div>
  </div>;
}
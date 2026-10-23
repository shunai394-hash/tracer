"use client";

import { useState } from "react";

type Job = {
  jobName: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  processed: number | null;
  failed: number | null;
  error: string | null;
};
type Payload = { ok: boolean; error?: string; generatedAt?: string; jobs?: Job[]; source?: string };

function time(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ja-JP", { hour12: false });
}
function statusLabel(value: string) {
  if (value === "succeeded" || value === "success" || value === "completed") return "成功";
  if (value === "failed" || value === "stale") return value === "stale" ? "長時間実行中" : "失敗";
  if (value === "running") return "実行中";
  return value;
}

export default function BotLiveStatus() {
  const [token, setToken] = useState("");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh() {
    if (!token.trim()) {
      setMessage("管理用トークン（TRACER_ADMIN_TOKEN）を入力してください。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/operations-status", {
        headers: { Authorization: `Bearer ${token.trim()}` },
        cache: "no-store",
      });
      const body = await response.json() as Payload;
      if (!response.ok || !body.ok) throw new Error(body.error === "unauthorized" ? "認証に失敗しました。トークンを確認してください。" : body.error ?? "状態の取得に失敗しました。");
      setPayload(body);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "状態の取得に失敗しました。");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mt-10 border border-cyan-300/20 bg-[#0a0d10] p-5 sm:p-7" aria-labelledby="live-status-heading">
      <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-300/70">Live run ledger</p>
      <h2 id="live-status-heading" className="mt-2 text-xl text-zinc-100">BOT実行状況（実データ）</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">Supabaseの cron_runs に記録された直近の実行結果を表示します。これはスケジュール設定一覧ではありません。管理トークンはブラウザに保存しません。</p>
      <form className="mt-5 flex flex-col gap-3 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void refresh(); }}>
        <input aria-label="管理用トークン" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="TRACER_ADMIN_TOKEN" className="min-w-0 flex-1 border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-300/50" />
        <button type="submit" disabled={loading || !token.trim()} className="border border-cyan-300/40 px-4 py-2.5 text-sm text-cyan-100 disabled:opacity-40">{loading ? "取得中…" : "実行状況を読み込む"}</button>
      </form>
      {message ? <p role="alert" className="mt-3 text-sm text-amber-200">{message}</p> : null}
      {payload?.jobs ? (
        <>
          <p className="mt-4 text-xs text-zinc-500">取得時刻：{time(payload.generatedAt)} ・ データ元：{payload.source}</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead><tr className="border-b border-white/10 text-xs text-zinc-500"><th className="px-3 py-3 font-normal">BOT / ジョブ</th><th className="px-3 py-3 font-normal">直近状態</th><th className="px-3 py-3 font-normal">開始時刻</th><th className="px-3 py-3 font-normal">処理件数</th><th className="px-3 py-3 font-normal">失敗件数</th><th className="px-3 py-3 font-normal">所要時間</th></tr></thead>
              <tbody>{payload.jobs.map((job) => (
                <tr key={job.jobName} className="border-b border-white/5 align-top">
                  <td className="px-3 py-3 font-mono text-xs text-cyan-200">{job.jobName}</td>
                  <td className={`px-3 py-3 ${job.status === "failed" || job.status === "stale" ? "text-red-300" : job.status === "running" ? "text-amber-200" : "text-zinc-200"}`}>{statusLabel(job.status)}</td>
                  <td className="px-3 py-3 whitespace-nowrap text-zinc-400">{time(job.startedAt)}</td>
                  <td className="px-3 py-3 text-zinc-300">{job.processed ?? "—"}</td>
                  <td className="px-3 py-3 text-zinc-300">{job.failed ?? "—"}</td>
                  <td className="px-3 py-3 text-zinc-400">{typeof job.durationMs === "number" ? `${Math.round(job.durationMs / 1000)}秒` : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {payload.jobs.length === 0 ? <p className="mt-4 text-sm text-zinc-400">cron_runs に実行履歴がありません。未実行と記録欠落は、この表示だけでは区別できません。</p> : null}
          <p className="mt-4 text-xs leading-5 text-zinc-500">注意：履歴に存在しないBOTは未実行か、履歴テーブルに記録していない可能性があります。失敗の詳細は必要な範囲だけ表示し、秘密情報を含む生ログは公開しません。</p>
        </>
      ) : null}
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";

type StartResponse = { ok: boolean; authorizationUrl?: string; error?: string; expiresInSeconds?: number };

export default function YouTubeLiveConnect() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("youtube");
    if (result === "connected") setMessage("YouTubeアカウントの認証情報を暗号化して保存した。");
    if (result === "failed") setMessage("YouTube接続に失敗した。OAuth設定・DBマイグレーション・Google側の許可を確認してくれ。");
  }, []);

  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.trim()) {
      setMessage("TRACER_ADMIN_TOKENを入力してください。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/ai-live/youtube/connect", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" },
        cache: "no-store",
      });
      const body = await response.json() as StartResponse;
      if (!response.ok || !body.ok || !body.authorizationUrl) {
        throw new Error(body.error === "unauthorized" ? "管理トークンが正しくない。" : body.error ?? "接続URLを作成できなかった。");
      }
      setToken("");
      window.location.assign(body.authorizationUrl);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "YouTube接続を開始できなかった。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 border border-red-300/20 bg-[#0a0d10] p-5 sm:p-7" aria-labelledby="youtube-connect-heading">
      <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-red-200">AI LIVE / YouTube</p>
      <h2 id="youtube-connect-heading" className="mt-2 text-xl text-zinc-100">YouTubeアカウント接続</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-300">
        管理トークンを使ってGoogle認証を開始する。認証後のリフレッシュトークンは暗号化してサーバー側に保存し、ブラウザには返さない。TikTok接続は別途、承認済みコネクターが必要。
      </p>
      <form onSubmit={(event) => void connect(event)} className="mt-5 flex flex-col gap-3 sm:flex-row">
        <input
          type="password"
          autoComplete="current-password"
          aria-label="TRACER管理トークン"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="TRACER_ADMIN_TOKEN"
          className="min-w-0 flex-1 border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-red-300/50"
        />
        <button
          type="submit"
          disabled={busy || !token.trim()}
          className="border border-red-300/40 px-4 py-2.5 text-sm text-red-100 disabled:opacity-40"
        >
          {busy ? "接続準備中…" : "Googleアカウントを接続"}
        </button>
      </form>
      {message ? <p role="status" className="mt-3 text-sm text-zinc-200">{message}</p> : null}
      <p className="mt-3 text-xs leading-5 text-zinc-300">
        接続前にGoogle OAuthのClient ID / Secret、コールバックURL、暗号化キー、AI_LIVE_WORKER_TOKENをVercelとWorkerに設定し、SupabaseのOAuth保存用マイグレーションを適用すること。
      </p>
    </section>
  );
}

"use client";

import { useState } from "react";

export function OrderActions({
  recommendationId,
  orderState,
}: {
  recommendationId: string;
  orderState: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const blocked =
    orderState === "ORDER_FORBIDDEN" || orderState === "UNKNOWN_BLOCKED";

  async function submit(approved: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recommendationId, approved }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      setMessage(
        payload.ok
          ? approved
            ? "発注を記録しました。仕入先API未接続のため実発注は実行していません。"
            : "発注案を下書きとして保存しました。"
          : payload.error ?? "処理できませんでした",
      );
    } catch {
      setMessage("処理できませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => void submit(false)}
        className="border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-zinc-200 disabled:opacity-40"
      >
        発注案を確認
      </button>
      <button
        type="button"
        disabled={busy || blocked}
        onClick={() => void submit(true)}
        className="border border-cyan-400/40 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        発注する
      </button>
      {message ? <p className="w-full text-xs text-zinc-400">{message}</p> : null}
    </div>
  );
}

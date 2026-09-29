"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CancelOrderForm({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/shop/orders/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, email, reason }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string; status?: string; reason?: string | null };
      if (!payload.ok) throw new Error(payload.error ?? "キャンセルを受け付けられませんでした");
      setMessage(
        payload.status === "refund_pending"
          ? "キャンセルを受け付けました。返金処理または仕入先確認を進めます。"
          : "キャンセルを受け付けました。",
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "キャンセルに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 border border-white/10 p-5">
      <h2 className="text-lg text-zinc-100">注文のキャンセル</h2>
      <p className="mt-2 text-xs text-zinc-500">注文時のメールアドレスを入力してください。仕入れ状況と決済状態を確認して処理します。</p>
      <input
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        type="email"
        placeholder="注文時のメールアドレス"
        className="mt-4 w-full border border-white/15 bg-black px-3 py-2 text-sm"
      />
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="キャンセル理由（任意）"
        className="mt-3 w-full border border-white/15 bg-black px-3 py-2 text-sm"
        rows={2}
      />
      <button
        type="button"
        onClick={() => void cancel()}
        disabled={busy || !email.trim()}
        className="mt-3 border border-amber-300 px-4 py-2 text-sm text-amber-100 disabled:opacity-40"
      >
        {busy ? "処理中…" : "注文をキャンセルする"}
      </button>
      {message ? <p className="mt-3 text-sm text-zinc-300">{message}</p> : null}
    </section>
  );
}

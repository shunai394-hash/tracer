"use client";

import { useState } from "react";

export function StartTestButton({
  opportunityId,
  enabled,
}: {
  opportunityId: string;
  enabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function startTest() {
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch("/api/intelligence/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunityId }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: string;
      };

      setMessage(
        payload.ok
          ? "テストを開始として記録しました。実売データはまだありません。"
          : payload.error || "開始できませんでした",
      );
    } catch {
      setMessage("開始できませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={startTest}
        disabled={!enabled || busy}
        className="border border-cyan-400/40 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-cyan-200 transition-colors hover:bg-cyan-400/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Starting…" : "TEST"}
      </button>
      {message ? (
        <p className="mt-2 text-xs leading-5 text-zinc-400">{message}</p>
      ) : null}
    </div>
  );
}

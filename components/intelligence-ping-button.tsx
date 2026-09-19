"use client";

import { useState } from "react";

type PingResult = {
  ok: boolean;
  message: string;
};

export function IntelligencePingButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PingResult | null>(null);

  async function ping() {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/intelligence/ping", { method: "POST" });
      const payload = (await response.json()) as PingResult;
      setResult({
        ok: payload.ok,
        message: payload.message || (response.ok ? "Reached Gemini" : "Request failed"),
      });
    } catch {
      setResult({ ok: false, message: "Request failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={ping}
        disabled={busy}
        className="border border-cyan-400/40 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-cyan-200 transition-colors hover:bg-cyan-400/10 disabled:opacity-50"
      >
        {busy ? "Pinging…" : "Ping Gemini"}
      </button>
      {result ? (
        <p
          className={`mt-3 text-sm ${result.ok ? "text-emerald-400" : "text-amber-400"}`}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

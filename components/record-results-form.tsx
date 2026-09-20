"use client";

import { useState, type FormEvent } from "react";

export function RecordResultsForm({ testId }: { testId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      provenance: "manual",
    };

    for (const key of [
      "impressions",
      "clicks",
      "add_to_cart",
      "checkout",
      "orders",
      "revenue",
      "ad_spend",
      "contribution_profit",
      "actual_selling_price",
      "returns",
    ]) {
      const value = String(form.get(key) ?? "").trim();
      if (value) body[key] = Number(value);
    }

    try {
      const response = await fetch(`/api/intelligence/tests/${testId}/results`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: string;
      };
      setMessage(
        payload.ok
          ? "実測結果を observed として保存しました。推定値は上書きしていません。"
          : payload.error || "保存できませんでした",
      );
    } catch {
      setMessage("保存できませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
      {[
        ["impressions", "Impressions"],
        ["clicks", "Clicks"],
        ["add_to_cart", "Add to cart"],
        ["checkout", "Checkout"],
        ["orders", "Orders"],
        ["revenue", "Revenue"],
        ["ad_spend", "Ad spend"],
        ["contribution_profit", "Actual contribution profit"],
        ["actual_selling_price", "Actual selling price"],
        ["returns", "Returns"],
      ].map(([name, label]) => (
        <label key={name} className="block text-xs text-zinc-400">
          {label}
          <input
            name={name}
            type="number"
            step="any"
            className="mt-1 w-full border border-white/10 bg-black/40 px-3 py-2 text-sm text-zinc-100"
          />
        </label>
      ))}
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={busy}
          className="border border-cyan-400/40 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save observed results"}
        </button>
        {message ? (
          <p className="mt-2 text-xs leading-5 text-zinc-400">{message}</p>
        ) : null}
      </div>
    </form>
  );
}

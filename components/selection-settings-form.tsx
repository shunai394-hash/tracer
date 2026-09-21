"use client";

import { useState } from "react";
import type { SelectionSettings } from "@/lib/intelligence/selection-config";

function emptyToNull(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function SelectionSettingsForm({
  initial,
}: {
  initial: SelectionSettings;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    minMarginPct: initial.minMarginPct?.toString() ?? "",
    minForecastUnits30d: initial.minForecastUnits30d?.toString() ?? "",
    maxSellerCount: initial.maxSellerCount?.toString() ?? "",
    minForecastProfit: initial.minForecastProfit?.toString() ?? "",
    maxWeightKg: initial.maxWeightKg?.toString() ?? "",
    allowedCategories: initial.allowedCategories.join(", "),
    excludedCategories: initial.excludedCategories.join(", "),
  });

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          min_margin_pct: emptyToNull(form.minMarginPct),
          min_forecast_units_30d: emptyToNull(form.minForecastUnits30d),
          max_seller_count: emptyToNull(form.maxSellerCount),
          min_forecast_profit: emptyToNull(form.minForecastProfit),
          max_weight_kg: emptyToNull(form.maxWeightKg),
          allowed_categories: form.allowedCategories
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          excluded_categories: form.excludedCategories
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      setMessage(payload.ok ? "選定フィルタを保存しました。" : payload.error ?? "保存できませんでした");
    } catch {
      setMessage("保存できませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="block text-sm text-zinc-300">
        最低利益率 %
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.minMarginPct}
          onChange={(event) =>
            setForm((current) => ({ ...current, minMarginPct: event.target.value }))
          }
          placeholder="未設定 = 判定に使わない"
        />
      </label>
      <label className="block text-sm text-zinc-300">
        最低予測販売数 30日
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.minForecastUnits30d}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              minForecastUnits30d: event.target.value,
            }))
          }
        />
      </label>
      <label className="block text-sm text-zinc-300">
        最大セラー数
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.maxSellerCount}
          onChange={(event) =>
            setForm((current) => ({ ...current, maxSellerCount: event.target.value }))
          }
        />
      </label>
      <label className="block text-sm text-zinc-300">
        最低予測利益
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.minForecastProfit}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              minForecastProfit: event.target.value,
            }))
          }
        />
      </label>
      <label className="block text-sm text-zinc-300">
        最大重量 kg
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.maxWeightKg}
          onChange={(event) =>
            setForm((current) => ({ ...current, maxWeightKg: event.target.value }))
          }
        />
      </label>
      <label className="block text-sm text-zinc-300">
        許可カテゴリ
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.allowedCategories}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              allowedCategories: event.target.value,
            }))
          }
        />
      </label>
      <label className="block text-sm text-zinc-300">
        除外カテゴリ
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.excludedCategories}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              excludedCategories: event.target.value,
            }))
          }
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="border border-cyan-400/40 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-cyan-200 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save filters"}
      </button>
      {message ? <p className="text-xs text-zinc-400">{message}</p> : null}
    </form>
  );
}

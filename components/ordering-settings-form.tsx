"use client";

import { useState } from "react";
import type { OrderingSettings } from "@/lib/ordering/types";

function emptyToNull(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function OrderingSettingsForm({
  initial,
}: {
  initial: OrderingSettings;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    mode: initial.mode,
    dailyOrderLimit: initial.dailyOrderLimit?.toString() ?? "",
    perProductOrderLimit: initial.perProductOrderLimit?.toString() ?? "",
    monthlyOrderBudget: initial.monthlyOrderBudget?.toString() ?? "",
    defaultLeadTimeDays: initial.defaultLeadTimeDays?.toString() ?? "",
    defaultSafetyStock: initial.defaultSafetyStock?.toString() ?? "",
  });

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/ordering", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: form.mode,
          dailyOrderLimit: emptyToNull(form.dailyOrderLimit),
          perProductOrderLimit: emptyToNull(form.perProductOrderLimit),
          monthlyOrderBudget: emptyToNull(form.monthlyOrderBudget),
          defaultLeadTimeDays: emptyToNull(form.defaultLeadTimeDays),
          defaultSafetyStock: emptyToNull(form.defaultSafetyStock),
        }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      setMessage(payload.ok ? "発注設定を保存しました。" : payload.error ?? "保存できませんでした");
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
        発注モード
        <select
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.mode}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              mode: event.target.value as OrderingSettings["mode"],
            }))
          }
        >
          <option value="MANUAL">MANUAL</option>
          <option value="APPROVAL">APPROVAL</option>
          <option value="AUTO">AUTO（全Gate通過時のみ）</option>
        </select>
      </label>
      <label className="block text-sm text-zinc-300">
        1日発注上限
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.dailyOrderLimit}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              dailyOrderLimit: event.target.value,
            }))
          }
        />
      </label>
      <label className="block text-sm text-zinc-300">
        1商品発注上限
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.perProductOrderLimit}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              perProductOrderLimit: event.target.value,
            }))
          }
        />
      </label>
      <label className="block text-sm text-zinc-300">
        月間発注予算
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.monthlyOrderBudget}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              monthlyOrderBudget: event.target.value,
            }))
          }
        />
      </label>
      <label className="block text-sm text-zinc-300">
        既定リードタイム日数
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.defaultLeadTimeDays}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              defaultLeadTimeDays: event.target.value,
            }))
          }
        />
      </label>
      <label className="block text-sm text-zinc-300">
        既定安全在庫
        <input
          className="mt-1 w-full border border-white/10 bg-black px-3 py-2 text-zinc-100"
          value={form.defaultSafetyStock}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              defaultSafetyStock: event.target.value,
            }))
          }
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="border border-cyan-400/40 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-cyan-200 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save ordering"}
      </button>
      {message ? <p className="text-xs text-zinc-400">{message}</p> : null}
    </form>
  );
}

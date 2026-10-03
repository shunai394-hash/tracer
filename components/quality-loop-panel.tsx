import Link from "next/link";

const stages = [
  ["01", "観測", "市場の変化を拾う"],
  ["02", "照合", "同じ商品か確かめる"],
  ["03", "仕入", "在庫・価格・配送を確認"],
  ["04", "判定", "販売条件を満たすか確認"],
  ["05", "販売", "実際の反応を観測"],
  ["06", "学習", "結果を次の選定へ戻す"],
] as const;

export function QualityLoopPanel() {
  return (
    <section aria-labelledby="quality-loop-heading" className="relative overflow-hidden border border-cyan-300/15 bg-zinc-950/70 p-6 sm:p-8">
      <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-cyan-300/10 blur-3xl" />
      <div className="relative">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-300/80">AI quality loop</p>
            <h2 id="quality-loop-heading" className="mt-2 text-2xl font-medium tracking-tight text-zinc-50 sm:text-3xl">
              見つけるだけで終わらせない。
            </h2>
          </div>
          <Link href="/intelligence" className="border border-white/10 px-4 py-2.5 text-xs text-zinc-300 transition hover:border-cyan-300/30 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
            商機を見る <span aria-hidden="true">→</span>
          </Link>
        </div>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-zinc-400">
          TRACERは、観測 → 確認 → 仕入 → 判定 → 販売 → 学習を循環させます。確認できないものは無理に進めず、次の観測で再チェックします。
        </p>

        <ol className="mt-8 grid gap-px overflow-hidden border border-white/8 bg-white/8 sm:grid-cols-2 lg:grid-cols-6" aria-label="AI品質循環">
          {stages.map(([number, title, copy]) => (
            <li key={number} className="bg-zinc-950/95 p-4 sm:p-5">
              <span className="font-mono text-[10px] tracking-[0.18em] text-cyan-300">{number}</span>
              <h3 className="mt-3 text-sm font-medium text-zinc-100">{title}</h3>
              <p className="mt-1.5 text-xs leading-5 text-zinc-500">{copy}</p>
            </li>
          ))}
        </ol>

        <div className="mt-6 flex flex-wrap gap-2 text-[11px] text-zinc-400">
          {["確認できた情報を優先", "不明は不明のまま", "条件未達は公開しない", "実測結果を次へ戻す"].map((label) => (
            <span key={label} className="border border-white/8 bg-white/[0.025] px-3 py-2">
              <span className="mr-1.5 text-cyan-300" aria-hidden="true">✓</span>{label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

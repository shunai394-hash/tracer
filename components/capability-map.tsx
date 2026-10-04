const layers = [
  {
    id: "bestsellers",
    label: "Bestsellers",
    stage: "01",
    copy: "最初に Amazon / 楽天 / Yahoo の売れ筋を観測します。未取得なら空です。",
  },
  {
    id: "identity",
    label: "Identity",
    stage: "02",
    copy: "ASIN/JAN 等で同一商品を確定します。商品名だけの一致は販売候補にしません。",
  },
  {
    id: "supply",
    label: "Dropship supply",
    stage: "03",
    copy: "無在庫仕入先で同一商品・価格・送料・追跡を確認します。未設定APIは unknown。",
  },
  {
    id: "profit",
    label: "Profit",
    stage: "04",
    copy: "確認できた費用だけで利益を計算します。不明費用は 0 円にしません。",
  },
  {
    id: "shop",
    label: "Sales test shop",
    stage: "05",
    copy: "条件を満たした最大3商品だけを公開し、実際の注文を観測します。",
  },
  {
    id: "demand",
    label: "Auxiliary demand",
    stage: "06",
    copy: "Google Trends と SNS は補助です。売れ筋の代替にはしません。",
  },
  {
    id: "forecast",
    label: "Forecast / Learning",
    stage: "07",
    copy: "予測は実測と分けます。足りない数字は unknown。",
  },
  {
    id: "test",
    label: "Test / Learning",
    stage: "08",
    copy: "カートと購入を実測し、次の選定に戻します。",
  },
] as const;

export function CapabilityMap() {
  return (
    <section aria-label="TRACER intelligence system map" className="relative overflow-hidden border border-cyan-300/12 bg-[#070b0e] p-5 sm:p-7">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/50 to-transparent" aria-hidden="true" />
      <div className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full border border-cyan-300/8 tracer-signal-drift" aria-hidden="true" />
      <div className="pointer-events-none absolute right-[8%] top-0 h-40 w-px bg-gradient-to-b from-transparent via-cyan-300/20 to-transparent tracer-signal-scan" aria-hidden="true" />

      <div className="relative flex flex-col gap-3 border-b border-white/7 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.32em] text-cyan-300/70">TRACER / System map</p>
          <h2 className="mt-2 text-xl tracking-[-0.025em] text-zinc-100 sm:text-2xl">判断を、8つの観測点でつなぐ。</h2>
        </div>
        <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">Signal → Evidence → Test → Learn</p>
      </div>

      <div className="relative mt-6 grid gap-px overflow-hidden border border-white/7 bg-white/7 sm:grid-cols-2 lg:grid-cols-4">
        {layers.map((layer, index) => (
          <article key={layer.id} className="group relative min-h-[190px] overflow-hidden bg-[#090d10] p-5 transition duration-500 hover:-translate-y-1 hover:bg-[#0c1216] sm:p-6">
            <div className="absolute left-0 top-0 h-px w-0 bg-cyan-300/70 transition-all duration-700 group-hover:w-full" aria-hidden="true" />
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9px] tracking-[0.2em] text-cyan-300/65">{layer.stage}</span>
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute h-full w-full rounded-full bg-cyan-300/25 tracer-signal-pulse" />
                <span className="relative h-2 w-2 rounded-full bg-cyan-300/80" />
              </span>
            </div>
            <h3 className="mt-9 text-base font-medium tracking-tight text-zinc-100">{layer.label}</h3>
            <p className="mt-2 text-xs leading-5 text-zinc-500 transition-colors duration-500 group-hover:text-zinc-300">{layer.copy}</p>
            <div className="absolute bottom-5 left-5 right-5 flex items-center gap-2 sm:left-6 sm:right-6">
              <span className="h-px flex-1 bg-white/7" aria-hidden="true" />
              <span className="font-mono text-[8px] uppercase tracking-[0.18em] text-zinc-700">{index === layers.length - 1 ? "return" : "trace"}</span>
            </div>
          </article>
        ))}
      </div>

      <div className="relative mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] text-zinc-500">
        <span><span className="mr-1.5 text-cyan-300">●</span>observed</span>
        <span><span className="mr-1.5 text-zinc-600">—</span>evidence chain</span>
        <span><span className="mr-1.5 text-amber-300/80">●</span>unknown stays unknown</span>
      </div>
    </section>
  );
}

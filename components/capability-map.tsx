const layers = [
  {
    id: "world",
    label: "World",
    copy: "市場と商品の観測面。実データが接続されるまで空のままです。",
  },
  {
    id: "products",
    label: "Products",
    copy: "商品そのものの正規化された実体。観測結果とは分離します。",
  },
  {
    id: "signals",
    label: "Market Signals",
    copy: "価格・需要・供給から導く市場シグナル。",
  },
  {
    id: "price",
    label: "Price",
    copy: "ソースと時刻付きの価格観測。",
  },
  {
    id: "demand",
    label: "Demand",
    copy: "需要の変化。未観測の値は表示しません。",
  },
  {
    id: "supply",
    label: "Supply",
    copy: "供給の変化。未観測の値は表示しません。",
  },
  {
    id: "discoveries",
    label: "AI Discoveries",
    copy: "Gemini による発掘候補。判定ロジックは未実装です。",
  },
] as const;

export function CapabilityMap() {
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {layers.map((layer) => (
        <article
          key={layer.id}
          className="border border-cyan-500/15 bg-zinc-950/70 p-5"
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-400/80">
            Layer
          </p>
          <h2 className="mt-2 text-lg text-zinc-100">{layer.label}</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">{layer.copy}</p>
          <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-600">
            No observations yet
          </p>
        </article>
      ))}
    </section>
  );
}

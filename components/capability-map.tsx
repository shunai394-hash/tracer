const layers = [
  {
    id: "world",
    label: "World",
    copy: "市場と商品の観測面。実データが接続されるまで空のままです。",
  },
  {
    id: "demand",
    label: "Demand",
    copy: "検索・SNS・レビューなど、観測された需要シグナル。",
  },
  {
    id: "gap",
    label: "Market Gap",
    copy: "需要と供給、価格差から見える隙間。未観測なら unknown。",
  },
  {
    id: "why-now",
    label: "Why Now",
    copy: "今テストする理由。実データからしか作りません。",
  },
  {
    id: "product",
    label: "Product",
    copy: "正規化された商品実体。観測結果とは分離します。",
  },
  {
    id: "supply",
    label: "Supply",
    copy: "仕入れ可能な供給。未確認なら低評価ではなく confidence を下げます。",
  },
  {
    id: "profit",
    label: "Profit",
    copy: "通貨が信頼できる価格だけで貢献利益を計算します。",
  },
  {
    id: "test",
    label: "Test / Learning",
    copy: "TEST_READY から販売テストし、実測を Opportunity へ戻します。",
  },
] as const;

export function CapabilityMap() {
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {layers.map((layer) => (
        <article
          key={layer.id}
          className="border border-cyan-500/15 bg-zinc-950/70 p-5"
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-400/80">
            Loop
          </p>
          <h2 className="mt-2 text-lg text-zinc-100">{layer.label}</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">{layer.copy}</p>
        </article>
      ))}
    </section>
  );
}

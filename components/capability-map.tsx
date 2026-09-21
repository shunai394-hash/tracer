const layers = [
  {
    id: "bestsellers",
    label: "Bestsellers",
    copy: "最初に Amazon / 楽天 / Yahoo の売れ筋を観測します。未取得なら空です。",
  },
  {
    id: "identity",
    label: "Identity",
    copy: "ASIN/JAN 等で同一商品を確定します。商品名だけの一致は販売候補にしません。",
  },
  {
    id: "supply",
    label: "Dropship supply",
    copy: "無在庫仕入先で同一商品・価格・送料・追跡を確認します。未設定APIは unknown。",
  },
  {
    id: "profit",
    label: "Profit",
    copy: "確認できた費用だけで利益を計算します。不明費用は 0 円にしません。",
  },
  {
    id: "shop",
    label: "Sales test shop",
    copy: "条件を満たした最大3商品だけを公開し、実際の注文を観測します。",
  },
  {
    id: "demand",
    label: "Auxiliary demand",
    copy: "Google Trends と SNS は補助です。売れ筋の代替にはしません。",
  },
  {
    id: "forecast",
    label: "Forecast / Learning",
    copy: "予測は実測と分けます。足りない数字は unknown。",
  },
  {
    id: "test",
    label: "Test / Learning",
    copy: "カートと購入を実測し、次の選定に戻します。",
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

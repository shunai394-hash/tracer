import { CapabilityMap } from "@/components/capability-map";
import { ConnectionPanel } from "@/components/connection-panel";
import { getFoundationStatus } from "@/lib/config/env";

export default function HomePage() {
  const status = getFoundationStatus();

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-12 px-6 py-16">
      <section className="max-w-3xl">
        <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
          World market scan
        </p>
        <h1 className="mt-4 text-4xl leading-tight tracking-tight text-zinc-50 sm:text-5xl">
          世界の商品・市場の動きを追跡する
          <span className="block text-cyan-200">AI Commerce Intelligence</span>
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-400">
          TRACER は、いま市場で売れている商品を先に観測し、同一商品を無在庫で仕入れられるか確認してから販売テストします。
          売れそうという推測では商品を選びません。確認できない項目は unknown です。
        </p>
      </section>

      <CapabilityMap />

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="border border-amber-400/15 bg-zinc-950/60 p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-amber-300/80">
            Pipeline
          </p>
          <h2 className="mt-2 text-xl text-zinc-100">観測と実体を分ける</h2>
          <ol className="mt-4 space-y-3 text-sm leading-6 text-zinc-400">
            <li>1. Bestsellers — Amazon / 楽天 / Yahoo の売れ筋を観測する</li>
            <li>2. Identity / Supply — 識別子で同一商品を確定し、無在庫仕入を調べる</li>
            <li>3. Profit — 確認できた費用だけで利益を計算する。不明費用は 0 円にしない</li>
            <li>4. Shop — 最大3商品を公開し、カートと注文を実測する</li>
            <li>5. Auxiliary — Trends / SNS は補助。売れ筋の代替にはしない</li>
          </ol>
        </section>
        <ConnectionPanel status={status} />
      </div>
    </main>
  );
}

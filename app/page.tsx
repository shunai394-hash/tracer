import Link from "next/link";
import { CapabilityMap } from "@/components/capability-map";
import { ConnectionPanel } from "@/components/connection-panel";
import { getFoundationStatus } from "@/lib/config/env";

const actions = [
  {
    href: "/bestsellers",
    label: "Bestsellers",
    title: "売れ筋を見る",
    copy: "市場ランキングから観測できた商品を確認する。",
  },
  {
    href: "/intelligence",
    label: "Opportunities",
    title: "商機を見る",
    copy: "需要・供給・利益など、実データが揃った候補を見る。",
  },
  {
    href: "/shop",
    label: "Sales test",
    title: "販売テストを見る",
    copy: "公開条件を満たした商品だけを店舗で確認する。",
  },
  {
    href: "/extension",
    label: "Extension",
    title: "商品を取り込む",
    copy: "Chrome Extensionから商品情報をTRACERへ送る。",
  },
] as const;

const pipeline = [
  ["01", "Observe", "Amazon / 楽天 / Yahoo の売れ筋を観測"],
  ["02", "Identify", "ASIN / JAN 等で同一商品を確認"],
  ["03", "Supply", "無在庫仕入先・価格・送料・追跡を確認"],
  ["04", "Test", "条件が揃った商品だけ販売テストへ"],
] as const;

export default function HomePage() {
  const status = getFoundationStatus();

  return (
    <main className="flex-1">
      <section className="border-b border-cyan-500/10">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-6 py-16 lg:grid-cols-[1.2fr_0.8fr] lg:items-end lg:py-24">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">
              World market scan / Commerce intelligence
            </p>
            <h1 className="mt-5 text-4xl leading-[1.08] tracking-tight text-zinc-50 sm:text-6xl">
              売れている商品を観測し、
              <span className="block text-cyan-200">販売テストまでつなぐ。</span>
            </h1>
            <p className="mt-7 max-w-2xl text-base leading-8 text-zinc-400">
              TRACER は、市場の売れ筋・商品識別・仕入条件・利益を一つのループで追跡する
              AI Commerce Intelligence。推測で埋めず、確認できない値は unknown として扱います。
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/intelligence"
                className="border border-cyan-400/50 bg-cyan-400/10 px-5 py-3 font-mono text-xs uppercase tracking-[0.18em] text-cyan-100 hover:bg-cyan-400/20"
              >
                商機を見る
              </Link>
              <Link
                href="/shop"
                className="border border-white/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.18em] text-zinc-200 hover:border-white/30"
              >
                販売テスト店舗
              </Link>
            </div>
          </div>

          <div className="border border-cyan-500/15 bg-zinc-950/70 p-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
              Core rule
            </p>
            <p className="mt-4 text-xl leading-8 text-zinc-100">
              「売れそう」ではなく、
              <span className="text-cyan-200">「確認できた」</span>
              から進める。
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              {[
                ["Market", "売れ筋観測"],
                ["Identity", "同一商品確認"],
                ["Supply", "仕入条件確認"],
                ["Test", "実販売観測"],
              ].map(([label, value]) => (
                <div key={label} className="border border-white/8 bg-black/30 p-3">
                  <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-600">
                    {label}
                  </p>
                  <p className="mt-1 text-sm text-zinc-300">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 py-14">
        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-400">
              Navigate
            </p>
            <h2 className="mt-2 text-2xl text-zinc-100">今すぐ使う</h2>
          </div>
          <Link href="/dashboard" className="hidden text-xs text-zinc-500 hover:text-zinc-200 sm:block">
            Dashboard →
          </Link>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {actions.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="group border border-white/10 bg-zinc-950/50 p-5 hover:border-cyan-400/30 hover:bg-cyan-400/[0.03]"
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-400/70">
                {action.label}
              </p>
              <h3 className="mt-3 text-lg text-zinc-100">{action.title}</h3>
              <p className="mt-2 text-sm leading-6 text-zinc-500">{action.copy}</p>
              <span className="mt-5 block text-xs text-zinc-600 group-hover:text-cyan-300">
                Open →
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="border-y border-white/5 bg-black/20">
        <div className="mx-auto w-full max-w-6xl px-6 py-14">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-amber-300/80">
            Intelligence loop
          </p>
          <h2 className="mt-2 text-2xl text-zinc-100">観測 → 確認 → 仕入 → テスト</h2>
          <div className="mt-8 grid gap-3 md:grid-cols-4">
            {pipeline.map(([number, title, copy]) => (
              <article key={number} className="border border-white/8 p-5">
                <p className="font-mono text-xs text-cyan-400">{number}</p>
                <h3 className="mt-3 text-lg text-zinc-100">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-500">{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 py-14">
        <CapabilityMap />
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-6 px-6 pb-20 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="border border-amber-400/15 bg-zinc-950/60 p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-amber-300/80">
            Data discipline
          </p>
          <h2 className="mt-2 text-xl text-zinc-100">不明を不明のまま扱う</h2>
          <ol className="mt-4 space-y-3 text-sm leading-6 text-zinc-400">
            <li>1. 商品名だけの一致は同一商品と確定しない</li>
            <li>2. 未確認の送料・手数料を 0 円として利益計算しない</li>
            <li>3. Trends / SNS は補助情報で、売れ筋観測の代替にしない</li>
            <li>4. 販売テストは確認済み条件が揃った商品から開始する</li>
          </ol>
        </div>
        <ConnectionPanel status={status} />
      </section>
    </main>
  );
}

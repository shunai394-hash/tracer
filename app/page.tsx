import Link from "next/link";
import { CapabilityMap } from "@/components/capability-map";
import { ConnectionPanel } from "@/components/connection-panel";
import { QualityLoopPanel } from "@/components/quality-loop-panel";
import { getFoundationStatus } from "@/lib/config/env";

const actions = [
  { href: "/shop", eyebrow: "01 / Selection", title: "いま試せる商品", copy: "確認できた条件が揃った商品だけを見る。", accent: "商品を見る" },
  { href: "/bestsellers", eyebrow: "02 / Market", title: "市場の動きを見る", copy: "いま注目されている変化から探す。", accent: "市場を見る" },
  { href: "/intelligence", eyebrow: "03 / Discovery", title: "次の商機を探す", copy: "需要・商品・仕入条件を一つずつ確かめる。", accent: "商機を見る" },
  { href: "/extension", eyebrow: "04 / Capture", title: "気になる商品を送る", copy: "見つけた商品をTRACERの確認へつなぐ。", accent: "取り込む" },
] as const;

const principles = [
  ["01", "同じ商品か", "名前だけでは決めない。識別できる証拠を優先する。"],
  ["02", "本当に仕入れられるか", "在庫・バリエーション・配送条件を確認する。"],
  ["03", "販売できる条件か", "価格・利益・需要が揃うまで公開しない。"],
  ["04", "結果を次へ返す", "実際の反応を次の選定と改善へ戻す。"],
] as const;

const customerBenefits = [
  ["探す", "市場・需要・商品候補を、同じ場所から辿れる。", "情報を集める前に、次に見るべき場所がわかる。"],
  ["確かめる", "商品同一性、仕入、価格、配送、利益を順番に確認する。", "名前や雰囲気だけで判断せず、理由を持って進める。"],
  ["決める", "条件が揃ったものだけを販売テストへ送る。", "「なぜこれを試すのか」を説明できる状態にする。"],
  ["学ぶ", "販売結果を次の選定とAI循環へ戻す。", "一度見つけて終わりではなく、使うほど判断材料が増える。"],
] as const;

export default function HomePage() {
  const status = getFoundationStatus();

  return (
    <main className="flex-1 bg-[#07090b]">
      <section className="relative isolate overflow-hidden border-b border-white/8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_72%_20%,rgba(34,211,238,0.12),transparent_28%),radial-gradient(circle_at_8%_88%,rgba(34,211,238,0.055),transparent_32%)]" />
        <div className="pointer-events-none absolute right-[8%] top-24 hidden h-56 w-56 rounded-full border border-cyan-200/10 lg:block" />
        <div className="pointer-events-none absolute right-[11%] top-32 hidden h-40 w-40 rounded-full border border-cyan-200/8 lg:block" />

        <div className="relative mx-auto grid w-full max-w-[1400px] gap-14 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)] lg:items-center lg:px-10 lg:py-28">
          <div className="max-w-4xl">
            <div className="tracer-reveal flex items-center gap-3 text-[10px] font-mono uppercase tracking-[0.34em] text-cyan-300/80">
              <span className="h-px w-8 bg-cyan-300/50" aria-hidden="true" />
              TRACER
              <span className="text-zinc-700">AI commerce intelligence</span>
            </div>
            <h1 className="tracer-reveal tracer-reveal-delay-1 mt-7 text-[clamp(3.5rem,8vw,7.6rem)] font-medium leading-[0.88] tracking-[-0.065em] text-zinc-50">
              次に、
              <span className="block text-cyan-200">試してみたい。</span>
            </h1>
            <p className="tracer-reveal tracer-reveal-delay-2 mt-8 max-w-2xl text-[15px] leading-8 text-zinc-300 sm:text-lg sm:leading-9">
              探す、比べる、確かめるを一つにつなぐ。<br className="hidden sm:block" />
              TRACERは「気になる商品」を、理由を持って試せるところまで丁寧につなぎます。
            </p>

            <div className="tracer-reveal tracer-reveal-delay-3 mt-9 flex flex-wrap gap-3">
              <Link href="/shop" className="group inline-flex min-h-12 items-center bg-cyan-300 px-6 py-3.5 text-xs font-semibold tracking-[0.08em] text-zinc-950 transition duration-300 hover:-translate-y-0.5 hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200">
                商品を見る
                <span className="ml-4 transition-transform duration-300 group-hover:translate-x-1" aria-hidden="true">→</span>
              </Link>
              <Link href="/bestsellers" className="group inline-flex min-h-12 items-center border border-white/15 px-6 py-3.5 text-xs font-medium text-zinc-200 transition duration-300 hover:-translate-y-0.5 hover:border-cyan-300/40 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
                市場を見る
                <span className="ml-4 text-zinc-600 transition-transform duration-300 group-hover:translate-x-1" aria-hidden="true">↗</span>
              </Link>
            </div>

            <div className="tracer-reveal tracer-reveal-delay-3 mt-10 flex flex-wrap gap-x-7 gap-y-3 border-t border-white/8 pt-5 text-[11px] text-zinc-500">
              <span><span className="mr-2 text-cyan-300">✓</span>確認できた情報を優先</span>
              <span><span className="mr-2 text-cyan-300">✓</span>不明は推測で埋めない</span>
              <span><span className="mr-2 text-cyan-300">✓</span>実測を次へ返す</span>
            </div>
          </div>

          <div className="tracer-reveal tracer-reveal-delay-2 relative lg:justify-self-end lg:w-full lg:max-w-[440px]">
            <div className="absolute -inset-4 border border-cyan-300/5" aria-hidden="true" />
            <div className="relative border border-white/10 bg-[#0a0d10]/90 p-6 shadow-2xl shadow-cyan-950/20 backdrop-blur sm:p-8">
              <div className="flex items-center justify-between border-b border-white/8 pb-5">
                <div>
                  <p className="text-[9px] font-mono uppercase tracking-[0.28em] text-zinc-600">TRACER standard</p>
                  <p className="mt-1.5 text-sm text-zinc-200">公開する前に、確かめる。</p>
                </div>
                <span className="relative flex h-3 w-3" aria-label="quality loop">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-300/30" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-cyan-300" />
                </span>
              </div>

              <ol className="mt-6 space-y-1" aria-label="商品選定の流れ">
                {[
                  ["市場", "変化を見つける"],
                  ["商品", "同じものか確かめる"],
                  ["仕入", "在庫・価格・配送を確認"],
                  ["販売", "条件が揃ったものだけ試す"],
                  ["学習", "結果を次の選定へ戻す"],
                ].map(([title, copy], index) => (
                  <li key={title} className="group grid grid-cols-[36px_72px_1fr] items-center border-b border-white/6 py-4 last:border-0">
                    <span className="font-mono text-[9px] text-zinc-700">0{index + 1}</span>
                    <span className="text-xs font-medium text-cyan-100">{title}</span>
                    <span className="text-xs text-zinc-500 transition group-hover:text-zinc-300">{copy}</span>
                  </li>
                ))}
              </ol>

              <div className="mt-5 border border-amber-300/10 bg-amber-300/[0.025] px-4 py-3">
                <p className="text-[11px] leading-5 text-zinc-500">
                  条件が足りない商品は、見栄えのために公開しません。確認できるまで次の循環へ戻します。
                </p>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden border border-white/6 bg-white/6" aria-label="TRACER signal readout">
                {[["EVIDENCE", "01"], ["GATE", "READY"], ["LOOP", "LIVE"]].map(([label, value]) => (
                  <div key={label} className="bg-[#080b0e] px-3 py-2.5">
                    <p className="font-mono text-[7px] tracking-[0.16em] text-zinc-700">{label}</p>
                    <p className="mt-1 font-mono text-[9px] text-cyan-200/75">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 lg:px-10 lg:py-24" aria-labelledby="benefit-heading">
        <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:items-start">
          <div className="max-w-md">
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-cyan-300/70">Why TRACER</p>
            <h2 id="benefit-heading" className="mt-3 text-3xl leading-tight tracking-[-0.04em] text-zinc-100 sm:text-4xl">
              使う理由は、<br />「判断が前に進む」こと。
            </h2>
            <p className="mt-5 text-sm leading-7 text-zinc-500">
              商品をたくさん見せるだけでは、次の一手は決まりません。TRACERは、発見から確認までをつなぎ、判断に必要な情報と理由を同じ流れで見せます。
            </p>
          </div>
          <div className="grid gap-px overflow-hidden border border-white/8 bg-white/8 sm:grid-cols-2">
            {customerBenefits.map(([title, copy, benefit], index) => (
              <article key={title} className="group bg-[#080b0e] p-6 transition duration-300 hover:bg-[#0c1014] sm:p-7">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono tracking-[0.2em] text-cyan-300/70">0{index + 1}</span>
                  <span className="h-px w-10 bg-white/10 transition-all duration-300 group-hover:w-16 group-hover:bg-cyan-300/40" aria-hidden="true" />
                </div>
                <h3 className="mt-8 text-xl text-zinc-100">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-400">{copy}</p>
                <p className="mt-5 border-t border-white/7 pt-4 text-xs leading-5 text-zinc-600">{benefit}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1400px] px-5 pb-16 sm:px-8 lg:px-10 lg:pb-24">
        <div className="flex flex-col gap-5 border-b border-white/8 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-cyan-300/70">Start with one</p>
            <h2 className="mt-3 text-3xl tracking-[-0.035em] text-zinc-100 sm:text-4xl">まず、ひとつ見つける。</h2>
          </div>
          <p className="max-w-sm text-xs leading-6 text-zinc-600 sm:text-right">見る場所を増やすより、次の一歩が迷わないことを優先しています。</p>
        </div>

        <div className="mt-8 grid gap-px overflow-hidden border border-white/8 bg-white/8 sm:grid-cols-2 lg:grid-cols-4">
          {actions.map((action, index) => (
            <Link key={action.href} href={action.href} className={`group relative min-h-[230px] bg-[#080b0e] p-6 transition duration-500 hover:-translate-y-1 hover:bg-[#0d1115] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-inset sm:p-7 tracer-reveal tracer-reveal-delay-${(index % 3) + 1}`}>
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-zinc-600">{action.eyebrow}</span>
                <span className="text-zinc-700 transition group-hover:translate-x-1 group-hover:text-cyan-200" aria-hidden="true">↗</span>
              </div>
              <div className="mt-16">
                <h3 className="text-xl tracking-tight text-zinc-100">{action.title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-500">{action.copy}</p>
              </div>
              <span className="absolute bottom-6 left-6 text-[10px] font-medium tracking-[0.12em] text-zinc-600 transition group-hover:text-cyan-200 sm:left-7">{action.accent} →</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="border-y border-white/6 bg-black/20">
        <div className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 lg:px-10 lg:py-24">
          <QualityLoopPanel />
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 lg:px-10 lg:py-24">
        <div className="grid gap-12 lg:grid-cols-[0.7fr_1.3fr] lg:items-end">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-amber-300/80">Why trust the selection</p>
            <h2 className="mt-3 text-3xl leading-tight tracking-[-0.035em] text-zinc-100 sm:text-4xl">商品を増やす前に、<br />精度を上げる。</h2>
            <p className="mt-5 max-w-md text-sm leading-7 text-zinc-500">「それっぽい」を大量に並べるのではなく、お客様が安心して次へ進める情報だけを積み上げます。</p>
          </div>
          <div className="grid gap-px overflow-hidden border border-white/8 bg-white/8 sm:grid-cols-2">
            {principles.map(([number, title, copy], index) => (
              <article key={number} className={`bg-[#080b0e] p-6 sm:p-7 tracer-reveal tracer-reveal-delay-${(index % 3) + 1}`}>
                <span className="font-mono text-[10px] text-cyan-300/70">{number}</span>
                <h3 className="mt-7 text-lg text-zinc-100">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-500">{copy}</p>
              </article>
            ))}
          </div>
        </div>
        <div className="mt-12"><CapabilityMap /></div>
      </section>

      <section className="mx-auto grid w-full max-w-[1400px] gap-6 px-5 pb-20 sm:px-8 lg:grid-cols-[1.15fr_0.85fr] lg:px-10 lg:pb-28">
        <div className="border border-amber-300/12 bg-[#0a0c0e] p-6 sm:p-8">
          <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-amber-300/80">Data discipline</p>
          <h2 className="mt-3 text-2xl tracking-tight text-zinc-100">わからないことを、わかったことにしない。</h2>
          <ol className="mt-6 grid gap-4 text-sm leading-6 text-zinc-400 sm:grid-cols-2">
            <li className="border-l border-cyan-300/30 pl-4">商品名だけの一致は、同一商品と確定しない。</li>
            <li className="border-l border-cyan-300/30 pl-4">未確認の送料・手数料を、利益に入れない。</li>
            <li className="border-l border-cyan-300/30 pl-4">Trends / SNSは、補助情報として扱う。</li>
            <li className="border-l border-cyan-300/30 pl-4">条件未達の商品は、無理に公開しない。</li>
          </ol>
        </div>
        <ConnectionPanel status={status} />
      </section>
    </main>
  );
}

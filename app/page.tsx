import Link from "next/link";
import { CapabilityMap } from "@/components/capability-map";
import { ConnectionPanel } from "@/components/connection-panel";
import { QualityLoopPanel } from "@/components/quality-loop-panel";
import { getFoundationStatus } from "@/lib/config/env";

const routes = [
  { href: "/shop", number: "01", label: "SELECT", title: "試せる商品", copy: "確認が終わったものだけ。", arrow: "↗" },
  { href: "/bestsellers", number: "02", label: "OBSERVE", title: "市場を見る", copy: "いま動いている変化から。", arrow: "↗" },
  { href: "/intelligence", number: "03", label: "DISCOVER", title: "商機を探す", copy: "数字の裏側にある理由まで。", arrow: "↗" },
  { href: "/extension", number: "04", label: "CAPTURE", title: "商品を送る", copy: "見つけた瞬間を、検証へ。", arrow: "↗" },
] as const;

const evidence = [
  ["01", "IDENTITY", "同じ商品か", "識別子と証拠を優先"],
  ["02", "SUPPLY", "仕入れられるか", "在庫・価格・配送を確認"],
  ["03", "MARGIN", "販売できるか", "利益条件を確認"],
  ["04", "LEARN", "次へ返せるか", "結果を選定へ戻す"],
] as const;

export default function HomePage() {
  const status = getFoundationStatus();

  return (
    <main className="flex-1 overflow-hidden bg-[#05070a]">
      <section className="relative min-h-[calc(100svh-104px)] border-b border-white/8">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_38%,rgba(103,232,249,0.11),transparent_22%),radial-gradient(circle_at_18%_78%,rgba(103,232,249,0.045),transparent_26%)]" />
          <div className="absolute left-0 top-0 h-full w-px bg-white/5 lg:left-[7.2vw]" />
          <div className="absolute right-[7.2vw] top-0 h-full w-px bg-white/5" />
          <div className="absolute left-[7.2vw] right-[7.2vw] top-[19%] h-px bg-white/5" />
          <div className="absolute left-[7.2vw] right-[7.2vw] bottom-[16%] h-px bg-white/5" />
          <div className="absolute right-[10vw] top-[17%] h-[min(62vw,620px)] w-[min(62vw,620px)] rounded-full border border-cyan-200/[0.08]" />
          <div className="absolute right-[14vw] top-[23%] h-[min(48vw,480px)] w-[min(48vw,480px)] rounded-full border border-cyan-200/[0.06]" />
          <div className="absolute right-[18vw] top-[29%] h-[min(34vw,340px)] w-[min(34vw,340px)] rounded-full border border-cyan-200/[0.045]" />
        </div>

        <div className="relative mx-auto grid min-h-[calc(100svh-104px)] w-full max-w-[1600px] grid-cols-1 lg:grid-cols-[7.2vw_minmax(0,1fr)_7.2vw]">
          <div className="hidden border-r border-white/5 lg:block" />

          <div className="relative grid min-h-full lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
            <div className="flex flex-col justify-center px-6 py-20 sm:px-10 lg:px-14 lg:py-24 xl:px-20">
              <div className="tracer-reveal flex items-center gap-3 font-mono text-[9px] tracking-[0.38em] text-cyan-200/70">
                <span className="h-px w-12 bg-cyan-300/50" aria-hidden="true" />
                SIGNAL / 2026
              </div>

              <h1 className="tracer-reveal tracer-reveal-delay-1 mt-8 max-w-5xl text-[clamp(4.2rem,10.5vw,10.5rem)] font-medium leading-[0.78] tracking-[-0.075em] text-zinc-50">
                次に、
                <span className="block pl-[0.14em] text-cyan-200">試す。</span>
              </h1>

              <div className="tracer-reveal tracer-reveal-delay-2 mt-10 grid max-w-2xl gap-7 border-l border-cyan-300/30 pl-5 sm:grid-cols-[1fr_auto] sm:gap-10 sm:pl-6">
                <p className="text-sm leading-7 text-zinc-300 sm:text-base sm:leading-8">
                  気になる商品を見つける。<br />
                  その商品であることを確かめる。<br />
                  仕入れと販売の条件を揃える。<br />
                  <span className="text-zinc-100">そして、理由を持って試す。</span>
                </p>
                <p className="hidden max-w-[150px] self-end font-mono text-[8px] leading-5 tracking-[0.16em] text-zinc-600 sm:block">
                  DISCOVERY<br />
                  ↓<br />
                  EVIDENCE<br />
                  ↓<br />
                  ACTION
                </p>
              </div>

              <div className="tracer-reveal tracer-reveal-delay-3 mt-10 flex flex-wrap gap-3">
                <Link href="/shop" className="group inline-flex min-h-12 items-center bg-cyan-300 px-6 py-3 text-[10px] font-semibold tracking-[0.14em] text-zinc-950 transition duration-500 hover:-translate-y-1 hover:bg-cyan-200 hover:shadow-[0_18px_60px_rgba(103,232,249,0.16)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200">
                  試せる商品を見る
                  <span className="ml-8 transition-transform duration-500 group-hover:translate-x-1.5" aria-hidden="true">↗</span>
                </Link>
                <Link href="/intelligence" className="group inline-flex min-h-12 items-center border border-white/15 px-6 py-3 text-[10px] tracking-[0.14em] text-zinc-300 transition duration-500 hover:-translate-y-1 hover:border-cyan-300/40 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
                  商機を見る
                  <span className="ml-8 text-zinc-600 transition-transform duration-500 group-hover:translate-x-1.5 group-hover:text-cyan-200" aria-hidden="true">↗</span>
                </Link>
              </div>
            </div>

            <div className="relative hidden border-l border-white/5 lg:block">
              <div className="absolute inset-x-0 top-[19%] bottom-[16%] p-10 xl:p-14">
                <div className="flex h-full flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between border-b border-white/8 pb-4">
                      <span className="font-mono text-[8px] tracking-[0.25em] text-zinc-600">TRACER / FIELD NOTE</span>
                      <span className="flex items-center gap-2 font-mono text-[8px] tracking-[0.16em] text-cyan-200/60">
                        <i className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,.8)]" />
                        LIVE
                      </span>
                    </div>

                    <div className="mt-12">
                      <p className="font-mono text-[9px] tracking-[0.24em] text-zinc-600">THE QUESTION</p>
                      <p className="mt-5 max-w-sm text-2xl leading-[1.2] tracking-[-0.035em] text-zinc-100">
                        「売れそう」から、<br />
                        <span className="text-cyan-200">「試せる」へ。</span>
                      </p>
                    </div>
                  </div>

                  <div>
                    <div className="grid grid-cols-2 border border-white/8">
                      <div className="border-r border-white/8 p-4">
                        <p className="font-mono text-[7px] tracking-[0.18em] text-zinc-700">STANDARD</p>
                        <p className="mt-2 text-xs text-zinc-300">証拠を先に。</p>
                      </div>
                      <div className="p-4">
                        <p className="font-mono text-[7px] tracking-[0.18em] text-zinc-700">UNKNOWN</p>
                        <p className="mt-2 text-xs text-zinc-300">推測で埋めない。</p>
                      </div>
                    </div>
                    <div className="mt-3 flex justify-between font-mono text-[7px] tracking-[0.16em] text-zinc-700">
                      <span>34.7024° N</span><span>135.4959° E</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="hidden border-l border-white/5 lg:block" />
        </div>
      </section>

      <section className="border-b border-white/8 bg-[#07090c]" aria-labelledby="evidence-heading">
        <div className="mx-auto grid max-w-[1600px] lg:grid-cols-[7.2vw_minmax(0,1fr)_7.2vw]">
          <div className="hidden border-r border-white/5 lg:block" />
          <div className="grid sm:grid-cols-2 lg:grid-cols-4">
            {evidence.map(([number, label, title, copy], index) => (
              <article key={number} className={`group relative border-b border-white/8 p-6 transition-colors duration-500 hover:bg-white/[0.025] sm:p-8 lg:border-b-0 lg:border-r lg:border-white/8 xl:p-10 tracer-reveal tracer-reveal-delay-${(index % 3) + 1}`}>
                <span className="font-mono text-[9px] tracking-[0.2em] text-cyan-300/55">{number}</span>
                <p className="mt-7 font-mono text-[8px] tracking-[0.22em] text-zinc-600">{label}</p>
                <h2 className="mt-2 text-lg tracking-[-0.02em] text-zinc-100">{title}</h2>
                <p className="mt-2 text-xs leading-5 text-zinc-600">{copy}</p>
                <span className="absolute bottom-0 left-6 h-px w-0 bg-cyan-300/60 transition-all duration-700 group-hover:w-[calc(100%-3rem)] sm:left-8 lg:left-10" aria-hidden="true" />
              </article>
            ))}
          </div>
          <div className="hidden border-l border-white/5 lg:block" />
        </div>
      </section>

      <section className="mx-auto grid max-w-[1600px] lg:grid-cols-[7.2vw_minmax(0,1fr)_7.2vw]" aria-labelledby="routes-heading">
        <div className="hidden border-r border-white/5 lg:block" />
        <div className="px-6 py-20 sm:px-10 lg:px-14 lg:py-28 xl:px-20">
          <div className="flex flex-col gap-8 border-b border-white/8 pb-8 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="font-mono text-[9px] tracking-[0.32em] text-cyan-300/65">ENTER THE SYSTEM</p>
              <h2 id="routes-heading" className="mt-4 text-4xl tracking-[-0.05em] text-zinc-100 sm:text-5xl">ひとつ、見つける。</h2>
            </div>
            <p className="max-w-xs text-xs leading-6 text-zinc-600 sm:text-right">見る場所を増やすのではなく、次の判断へ最短でつなぐ。</p>
          </div>

          <div className="mt-8 grid border border-white/8 sm:grid-cols-2 lg:grid-cols-4">
            {routes.map((route, index) => (
              <Link key={route.href} href={route.href} className={`group relative min-h-[280px] border-b border-white/8 bg-[#080b0e] p-6 transition duration-700 hover:-translate-y-1 hover:bg-[#0b1014] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-inset sm:p-8 lg:border-b-0 lg:border-r last:lg:border-r-0 tracer-reveal tracer-reveal-delay-${(index % 3) + 1}`}>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[9px] tracking-[0.18em] text-zinc-600">{route.number}</span>
                  <span className="text-zinc-700 transition duration-500 group-hover:-translate-y-1 group-hover:translate-x-1 group-hover:text-cyan-200">{route.arrow}</span>
                </div>
                <div className="mt-20">
                  <p className="font-mono text-[8px] tracking-[0.22em] text-cyan-300/55">{route.label}</p>
                  <h3 className="mt-3 text-2xl tracking-[-0.035em] text-zinc-100">{route.title}</h3>
                  <p className="mt-2 text-xs text-zinc-600">{route.copy}</p>
                </div>
                <span className="absolute bottom-0 left-0 h-px w-0 bg-cyan-300 transition-all duration-700 group-hover:w-full" aria-hidden="true" />
              </Link>
            ))}
          </div>
        </div>
        <div className="hidden border-l border-white/5 lg:block" />
      </section>

      <section className="border-y border-white/8 bg-[#06080b]">
        <div className="mx-auto grid max-w-[1600px] lg:grid-cols-[7.2vw_minmax(0,1fr)_7.2vw]">
          <div className="hidden border-r border-white/5 lg:block" />
          <div className="px-6 py-20 sm:px-10 lg:px-14 lg:py-28 xl:px-20">
            <QualityLoopPanel />
          </div>
          <div className="hidden border-l border-white/5 lg:block" />
        </div>
      </section>

      <section className="mx-auto max-w-[1600px] lg:grid lg:grid-cols-[7.2vw_minmax(0,1fr)_7.2vw]">
        <div className="hidden border-r border-white/5 lg:block" />
        <div className="px-6 py-20 sm:px-10 lg:px-14 lg:py-28 xl:px-20">
          <div className="grid gap-12 lg:grid-cols-[0.55fr_1fr] lg:items-end">
            <div>
              <p className="font-mono text-[9px] tracking-[0.32em] text-amber-300/70">THE TRACER RULE</p>
              <h2 className="mt-4 text-4xl leading-[1.05] tracking-[-0.05em] text-zinc-100 sm:text-5xl">
                たくさんより、<br />
                <span className="text-zinc-500">確かなひとつ。</span>
              </h2>
              <p className="mt-6 max-w-md text-sm leading-7 text-zinc-500">
                商品を増やすことを目的にしない。確認できないものを無理に公開しない。判断の質を上げるために、情報を循環させる。
              </p>
            </div>
            <div className="border-t border-white/8">
              {[
                ["01", "商品名だけでは、同一商品と決めない。"],
                ["02", "未確認の送料・手数料を利益に入れない。"],
                ["03", "観測と推測を、同じ重さで扱わない。"],
                ["04", "結果を次の選定へ戻して、循環を止めない。"],
              ].map(([n, text]) => (
                <div key={n} className="group flex gap-6 border-b border-white/8 py-5 transition hover:bg-white/[0.02]">
                  <span className="font-mono text-[9px] text-cyan-300/55">{n}</span>
                  <span className="text-sm text-zinc-300 transition group-hover:text-zinc-100">{text}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-16"><CapabilityMap /></div>
        </div>
        <div className="hidden border-l border-white/5 lg:block" />
      </section>

      <section className="border-t border-white/8">
        <div className="mx-auto grid max-w-[1600px] lg:grid-cols-[7.2vw_minmax(0,1fr)_7.2vw]">
          <div className="hidden border-r border-white/5 lg:block" />
          <div className="grid gap-6 px-6 py-16 sm:px-10 lg:grid-cols-[1.1fr_0.9fr] lg:px-14 lg:py-24 xl:px-20">
            <div className="border border-amber-300/10 bg-[#080a0d] p-7 sm:p-9">
              <p className="font-mono text-[9px] tracking-[0.3em] text-amber-300/70">DATA DISCIPLINE</p>
              <h2 className="mt-4 text-2xl tracking-[-0.03em] text-zinc-100">わからないことを、わかったことにしない。</h2>
              <p className="mt-4 max-w-xl text-sm leading-7 text-zinc-600">TRACERの品質は、見せる情報の多さではなく、確かめた情報と不明な情報を正しく分けることから始まります。</p>
            </div>
            <ConnectionPanel status={status} />
          </div>
          <div className="hidden border-l border-white/5 lg:block" />
        </div>
      </section>
    </main>
  );
}

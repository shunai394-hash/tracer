import Link from "next/link";
import { CapabilityMap } from "@/components/capability-map";
import { ConnectionPanel } from "@/components/connection-panel";
import { QualityLoopPanel } from "@/components/quality-loop-panel";
import { getFoundationStatus } from "@/lib/config/env";

const actions = [
  { href: "/bestsellers", label: "WORLD NOW", title: "いま世界で動くもの", copy: "どこで、何が注目されているかを見る。" },
  { href: "/shop", label: "NEW FIND", title: "知らなかった商品", copy: "まだ出会っていない「気になる」を探す。" },
  { href: "/intelligence", label: "WHY THIS", title: "なぜ注目されている？", copy: "市場・供給・条件を確かめた情報を見る。" },
  { href: "/extension", label: "BRING IT", title: "これ、気になる", copy: "見つけた商品をTRACERに送って調べる。" },
] as const;

const gains = [
  ["発見の得", "自分で検索しなくても、知らなかった商品に出会える。"],
  ["時間の得", "世界の情報をAIが巡回し、見るべきものを絞る。"],
  ["情報の得", "商品だけでなく、なぜ注目されているかを確かめられる。"],
  ["判断の得", "不明な情報を推測で埋めず、確認できたことから選べる。"],
] as const;

export default function HomePage() {
  const status = getFoundationStatus();

  return (
    <main className="flex-1">
      <section className="relative overflow-hidden border-b border-cyan-500/10">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_70%_25%,rgba(34,211,238,0.10),transparent_34%),radial-gradient(circle_at_20%_80%,rgba(34,211,238,0.05),transparent_30%)]" />
        <div className="relative mx-auto grid w-full max-w-7xl gap-12 px-5 py-16 sm:px-6 lg:grid-cols-[1.25fr_0.75fr] lg:items-center lg:py-28">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-cyan-300">
              TRACER / WORLD PRODUCT DISCOVERY
            </p>
            <h1 className="mt-5 max-w-4xl text-5xl font-medium leading-[0.98] tracking-[-0.045em] text-zinc-50 sm:text-7xl lg:text-[5.5rem]">
              世界で今、
              <span className="block text-cyan-200">見つかっているもの。</span>
            </h1>
            <p className="mt-7 max-w-2xl text-base leading-8 text-zinc-300 sm:text-lg">
              海外で動き始めた商品、まだ知らない面白いものを見つける。
              TRACERのAIが世界を巡回し、確かめられたものを人の目に届く形にします。
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/shop"
                className="inline-flex items-center bg-cyan-300 px-5 py-3.5 text-xs font-medium tracking-[0.08em] text-zinc-950 transition hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
              >
                見つける <span className="ml-2" aria-hidden="true">→</span>
              </Link>
              <Link
                href="/bestsellers"
                className="inline-flex items-center border border-white/15 px-5 py-3.5 text-xs text-zinc-200 transition hover:border-cyan-300/40 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              >
                世界の動きを見る
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[11px] text-zinc-500">
              <span><span className="mr-1.5 text-cyan-300">✓</span>確認できた情報を優先</span>
              <span><span className="mr-1.5 text-cyan-300">✓</span>不明は推測で埋めない</span>
              <span><span className="mr-1.5 text-cyan-300">✓</span>実測を次の選定へ戻す</span>
            </div>
            <div className="mt-8 grid max-w-2xl grid-cols-1 gap-2 text-xs text-zinc-400 sm:grid-cols-3">
              <div className="border border-white/8 bg-white/[0.02] px-4 py-3">「こんなの知らなかった」</div>
              <div className="border border-white/8 bg-white/[0.02] px-4 py-3">「今、これが動いてるんだ」</div>
              <div className="border border-white/8 bg-white/[0.02] px-4 py-3">「ちょっと試したい」</div>
            </div>
          </div>

          <div className="border border-white/10 bg-zinc-950/75 p-6 shadow-2xl shadow-cyan-950/10 sm:p-7">
            <div className="flex items-center justify-between border-b border-white/8 pb-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-zinc-500">One quality rule</p>
              <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.8)]" aria-label="quality loop active" />
            </div>
            <p className="mt-6 text-2xl leading-9 tracking-tight text-zinc-100">
              「売れそう」ではなく、
              <span className="text-cyan-200">「確かめられた」</span>
              ものを次へ。
            </p>
            <div className="mt-7 grid grid-cols-2 gap-px overflow-hidden border border-white/8 bg-white/8">
              {[["Market", "市場"], ["Identity", "同一商品"], ["Supply", "仕入"], ["Test", "実測"]].map(([label, value]) => (
                <div key={label} className="bg-zinc-950 p-4">
                  <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-600">{label}</p>
                  <p className="mt-1.5 text-sm text-zinc-200">{value}</p>
                </div>
              ))}
            </div>
            <Link href="/intelligence" className="mt-6 block border-t border-white/8 pt-4 text-xs text-zinc-500 transition hover:text-cyan-200">
              仕組みと商機を見る <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-5 py-14 sm:px-6 lg:py-18">
        <div className="max-w-3xl">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300/80">WHY TRACER</p>
          <h2 className="mt-2 text-2xl tracking-tight text-zinc-100 sm:text-3xl">
            「商品を探す」だけではなく、探す時間そのものを減らす。
          </h2>
          <p className="mt-4 text-sm leading-7 text-zinc-500">
            マーケットプレイスは欲しいものを探す場所。TRACERは、その前に「まだ知らないもの」を見つける場所です。
            世界の変化を先に見て、気になる理由まで確かめる。そのためにAIを裏側で使います。
          </p>
        </div>
        <div className="mt-8 grid gap-px overflow-hidden border border-white/8 bg-white/8 sm:grid-cols-2 lg:grid-cols-4">
          {gains.map(([title, copy]) => (
            <div key={title} className="bg-zinc-950 p-5 sm:p-6">
              <p className="text-sm font-medium text-zinc-100">{title}</p>
              <p className="mt-3 text-xs leading-6 text-zinc-500">{copy}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-5 py-14 sm:px-6 lg:py-20">
        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300/80">DISCOVER SOMETHING NEW</p>
            <h2 className="mt-2 text-2xl tracking-tight text-zinc-100 sm:text-3xl">今日は、何を見つける？</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500">
              検索する前に、世界から届いた「気になる」をひとつ。知らなかった商品との出会いから始められます。
            </p>
          </div>
        </div>
        <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {actions.map((action, index) => (
            <Link
              key={action.href}
              href={action.href}
              className="group relative overflow-hidden border border-white/10 bg-zinc-950/55 p-5 transition duration-300 hover:-translate-y-1 hover:border-cyan-300/30 hover:bg-zinc-900/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              <span className="font-mono text-[10px] text-zinc-700">0{index + 1}</span>
              <p className="mt-6 font-mono text-[9px] uppercase tracking-[0.2em] text-cyan-300/70">{action.label}</p>
              <h3 className="mt-2 text-lg text-zinc-100">{action.title}</h3>
              <p className="mt-2 text-sm leading-6 text-zinc-500">{action.copy}</p>
              <span className="mt-7 block text-xs text-zinc-600 transition group-hover:text-cyan-200">開く →</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="border-y border-white/5 bg-black/20">
        <div className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-6 lg:py-20">
          <QualityLoopPanel />
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-6 lg:py-20">
        <div className="max-w-2xl">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-amber-300/80">How it stays precise</p>
          <h2 className="mt-2 text-2xl tracking-tight text-zinc-100 sm:text-3xl">速さより、確かさを積み上げる。</h2>
          <p className="mt-4 text-sm leading-7 text-zinc-500">
            商品名だけで決めない。未確認の費用を利益に入れない。補助シグナルを売れ筋と取り違えない。
            販売テストは確認済み条件が揃ったものから始めます。
          </p>
        </div>
        <div className="mt-8"><CapabilityMap /></div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-6 px-5 pb-20 sm:px-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="border border-amber-400/15 bg-zinc-950/60 p-6 sm:p-8">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-amber-300/80">Data discipline</p>
          <h2 className="mt-2 text-xl text-zinc-100">不明を不明のまま扱う。</h2>
          <ol className="mt-5 grid gap-3 text-sm leading-6 text-zinc-400 sm:grid-cols-2">
            <li className="border-l border-cyan-300/30 pl-3">商品名だけの一致は同一商品と確定しない</li>
            <li className="border-l border-cyan-300/30 pl-3">未確認の送料・手数料を0円として利益計算しない</li>
            <li className="border-l border-cyan-300/30 pl-3">Trends / SNSは補助情報として扱う</li>
            <li className="border-l border-cyan-300/30 pl-3">条件未達の商品は無理に公開しない</li>
          </ol>
        </div>
        <ConnectionPanel status={status} />
      </section>
    </main>
  );
}

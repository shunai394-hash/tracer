import Link from "next/link";
import { ConnectionPanel } from "@/components/connection-panel";
import { getFoundationStatus } from "@/lib/config/env";

const workspaces = [
  {
    number: "01",
    eyebrow: "PRODUCT CATALOG",
    title: "商品候補を確認",
    description: "需要データ、商品識別子、画像、価格を確認し、根拠のない候補を販売商品と混同しない。",
    href: "/bestsellers",
    action: "候補データを開く",
  },
  {
    number: "02",
    eyebrow: "SUPPLY & MARGIN",
    title: "仕入れと利益を照合",
    description: "仕入先の商品・バリエーション・在庫・配送費を照合。条件が未確認の商品は公開対象にしない。",
    href: "/intelligence",
    action: "照合・商機を確認",
  },
  {
    number: "03",
    eyebrow: "SALES CHANNELS",
    title: "販売商品を管理",
    description: "販売可否と掲載状態を確認。BASE・Shopifyの同期結果を、実際の掲載状態と分けて扱う。",
    href: "/shop",
    action: "販売商品を開く",
  },
  {
    number: "04",
    eyebrow: "CAPTURE",
    title: "見つけた商品を追加",
    description: "外部で見つけた商品の情報を取り込み、需要調査と仕入れ照合につなげる。",
    href: "/extension",
    action: "商品を取り込む",
  },
] as const;

const releaseGates = [
  ["01", "商品同一性", "JAN・GTIN・ASIN等で同一商品を確認"],
  ["02", "仕入れ条件", "仕入先・バリエーション・原価・送料を確認"],
  ["03", "販売可能性", "在庫・注文可否・追跡・利益を確認"],
  ["04", "チャネル反映", "BASE／Shopifyの実掲載結果を照合"],
] as const;

export default function HomePage() {
  const status = getFoundationStatus();

  return (
    <main className="min-h-full flex-1 bg-[#f5f6f4] text-[#171916]">
      <section className="border-b border-[#dfe2dc] bg-[#fbfcfa]">
        <div className="mx-auto max-w-[1440px] px-5 py-10 sm:px-8 sm:py-14 lg:px-12 lg:py-16">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="flex items-center gap-3 text-[11px] font-semibold tracking-[0.18em] text-[#53725a]">
                <span className="h-2 w-2 rounded-full bg-[#6b9271]" />
                TRACER / COMMERCE OPERATIONS
              </div>
              <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-[-0.055em] sm:text-6xl">
                商品を見つけ、<br className="sm:hidden" />確かめ、販売につなぐ。
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-7 text-[#62685f] sm:text-base">
                需要の発見から仕入れ照合、利益確認、BASE・Shopifyへの掲載まで。
                TRACERを、販売を前に進めるための実務コンソールとして使います。
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-3">
              <Link href="/shop" className="inline-flex min-h-12 items-center justify-center rounded-md bg-[#1e3525] px-5 text-sm font-semibold text-white transition hover:bg-[#2d4a34] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#53725a] focus-visible:ring-offset-2">
                販売商品を確認 <span className="ml-4" aria-hidden="true">↗</span>
              </Link>
              <Link href="/bestsellers" className="inline-flex min-h-12 items-center justify-center rounded-md border border-[#cdd3ca] bg-white px-5 text-sm font-semibold text-[#29352a] transition hover:bg-[#f0f3ee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#53725a] focus-visible:ring-offset-2">
                商品候補を見る
              </Link>
            </div>
          </div>
          <div className="mt-10 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-[#e1e5de] bg-white p-4 sm:p-5">
              <p className="text-xs font-medium text-[#73796f]">優先カテゴリ</p>
              <p className="mt-2 text-lg font-semibold tracking-tight">女性向けバッグ</p>
              <p className="mt-1 text-xs text-[#777d73]">次点：ビューティーツール／ヘアアクセ</p>
            </div>
            <div className="rounded-lg border border-[#e1e5de] bg-white p-4 sm:p-5">
              <p className="text-xs font-medium text-[#73796f]">事業目標</p>
              <p className="mt-2 text-lg font-semibold tracking-tight">売上 ¥160,000,000</p>
              <p className="mt-1 text-xs text-[#777d73]">掲載件数ではなく、販売品質と実績で追う</p>
            </div>
            <div className="rounded-lg border border-[#e1e5de] bg-white p-4 sm:p-5">
              <p className="text-xs font-medium text-[#73796f]">運用原則</p>
              <p className="mt-2 text-lg font-semibold tracking-tight">証拠が揃った商品だけ販売</p>
              <p className="mt-1 text-xs text-[#777d73]">未確認の在庫・利益・発注可否を推測しない</p>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1440px] px-5 py-10 sm:px-8 sm:py-12 lg:px-12">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.16em] text-[#638069]">WORKSPACES</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">次の作業へ進む</h2>
          </div>
          <p className="max-w-xl text-sm leading-6 text-[#747a70]">説明用の演出ではなく、各作業画面へ直接移動できます。</p>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {workspaces.map((item) => (
            <article key={item.number} className="group flex min-h-[260px] flex-col rounded-lg border border-[#dfe3dc] bg-white p-5 transition duration-200 hover:-translate-y-0.5 hover:border-[#b7c5b7] hover:shadow-[0_12px_32px_rgba(25,42,28,0.07)] sm:p-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold tabular-nums text-[#7a8c7a]">{item.number}</span>
                <span className="rounded-full bg-[#f0f4ef] px-2.5 py-1 text-[10px] font-semibold tracking-[0.08em] text-[#58715b]">{item.eyebrow}</span>
              </div>
              <h3 className="mt-8 text-xl font-semibold tracking-[-0.035em]">{item.title}</h3>
              <p className="mt-3 text-sm leading-6 text-[#6c7269]">{item.description}</p>
              <Link href={item.href} className="mt-auto inline-flex items-center pt-7 text-sm font-semibold text-[#31543a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#53725a]">
                {item.action}<span className="ml-2 transition-transform group-hover:translate-x-1" aria-hidden="true">→</span>
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-[#e0e4dd] bg-white">
        <div className="mx-auto grid max-w-[1440px] gap-10 px-5 py-10 sm:px-8 sm:py-12 lg:grid-cols-[1.05fr_0.95fr] lg:px-12">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.16em] text-[#638069]">PUBLICATION GATES</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em]">掲載前に通す4つの確認</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-[#747a70]">候補数を増やすことと、購入者に販売できる商品を増やすことは別です。確認できていない条件を通過扱いにしません。</p>
            <div className="mt-6 divide-y divide-[#e7eae5] border-y border-[#e7eae5]">
              {releaseGates.map(([number, title, description]) => (
                <div key={number} className="flex gap-4 py-4">
                  <span className="pt-0.5 text-xs font-semibold tabular-nums text-[#7a8c7a]">{number}</span>
                  <div>
                    <p className="text-sm font-semibold">{title}</p>
                    <p className="mt-1 text-sm leading-5 text-[#73796f]">{description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-[#dfe3dc] bg-[#f8f9f6] p-5 sm:p-6">
            <div className="mb-5">
              <p className="text-[11px] font-semibold tracking-[0.16em] text-[#638069]">SYSTEM CONNECTIONS</p>
              <h3 className="mt-2 text-xl font-semibold tracking-[-0.035em]">接続状態</h3>
              <p className="mt-2 text-sm leading-6 text-[#747a70]">接続診断の結果を表示します。接続済みであることは、商品掲載や発注が成功した証明ではありません。</p>
            </div>
            <ConnectionPanel status={status} />
          </div>
        </div>
      </section>

      <footer className="mx-auto flex max-w-[1440px] flex-col gap-2 px-5 py-8 text-xs text-[#81867d] sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12">
        <span>TRACER — Demand to verified commerce.</span>
        <span>商品候補・仕入れ・利益・掲載結果を分けて管理</span>
      </footer>
    </main>
  );
}

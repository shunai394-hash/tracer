import BotLiveStatus from "@/components/admin/bot-live-status";

const cards = [
  {
    title: "商品管理",
    description: "TRACERの商品を追加・編集・一覧から外す。商品ごとの公開ページを確認する。",
    href: "/dashboard",
    action: "商品管理を開く",
  },
  {
    title: "規則・規定",
    description: "商品選定フィルター、最低利益率、カテゴリ条件、注文モードと注文上限を設定する。",
    href: "/settings",
    action: "規則・設定を開く",
  },
  {
    title: "仕入先・販売状況",
    description: "商品と仕入先・variantの接続、BASE運用パネル、接続設定を確認する。",
    href: "/dashboard",
    action: "運用ダッシュボードを開く",
  },
];

const jobs = [
  ["/api/cron/patrol-ai", "5分ごと", "巡回・インテリジェンス処理"],
  ["/api/cron/shopify-orders", "5分ごと", "Shopify注文取り込み"],
  ["/api/cron/commerce-cj-import", "毎時00分・30分", "CJ商品取り込み"],
  ["/api/cron/commerce-publish-base", "30分ごと", "BASE掲載同期"],
  ["/api/cron/commerce-publish-shopify", "30分ごと", "Shopify掲載同期"],
  ["/api/cron/shopify-publish", "30分ごと", "Shopify掲載状態の照合"],
  ["/api/cron/commerce-base-orders", "毎時01・16・31・46分", "BASE注文取り込み"],
  ["/api/cron/commerce-procurement", "毎時13・28・43・58分", "仕入れ処理"],
  ["/api/cron/commerce-base-fulfillment", "毎時14・29・44・59分", "BASE発送処理"],
  ["/api/cron/shopify-fulfillment", "毎時07・22・37・52分", "Shopify発送処理"],
] as const;

export const dynamic = "force-dynamic";

export default function AdminOperationsPage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-400">TRACER Control Center</p>
      <h1 className="mt-3 text-3xl text-zinc-50">管理センター</h1>
      <p className="mt-4 max-w-3xl text-sm leading-6 text-zinc-400">
        商品、運用規則、自動処理への入口をまとめています。ここに表示するスケジュールは vercel.json の設定値であり、BOTの直近実行成功を意味しません。
      </p>

      <section className="mt-8 grid gap-4 md:grid-cols-3" aria-label="管理メニュー">
        {cards.map((card) => (
          <article key={card.title} className="flex flex-col border border-cyan-300/20 bg-[#0a0d10] p-5">
            <h2 className="text-lg text-zinc-100">{card.title}</h2>
            <p className="mt-3 flex-1 text-sm leading-6 text-zinc-400">{card.description}</p>
            <a href={card.href} className="mt-5 inline-flex w-fit border border-cyan-300/30 px-3 py-2 text-sm text-cyan-200 hover:bg-cyan-300/10">
              {card.action} →
            </a>
          </article>
        ))}
      </section>

      <BotLiveStatus />

      <section className="mt-10 border border-white/10 bg-[#0a0d10] p-5 sm:p-7" aria-labelledby="bots-heading">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-300/70">Scheduled automation</p>
            <h2 id="bots-heading" className="mt-2 text-xl text-zinc-100">BOT・自動処理一覧</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
              スケジュールが登録されている処理です。実行結果・失敗理由はVercelのLogs / Functionsで確認してください。ここからの停止操作はまだ提供していません。
            </p>
          </div>
          <a href="https://vercel.com/" target="_blank" rel="noreferrer" className="border border-white/15 px-3 py-2 text-sm text-cyan-200 hover:bg-white/5">
            Vercelで実行ログを見る ↗
          </a>
        </div>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs text-zinc-500">
                <th className="px-3 py-3 font-normal">処理</th>
                <th className="px-3 py-3 font-normal">設定スケジュール</th>
                <th className="px-3 py-3 font-normal">役割</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(([path, schedule, role]) => (
                <tr key={path} className="border-b border-white/5 align-top">
                  <td className="px-3 py-3 font-mono text-xs text-cyan-200">{path}</td>
                  <td className="px-3 py-3 whitespace-nowrap text-zinc-300">{schedule}</td>
                  <td className="px-3 py-3 text-zinc-400">{role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs leading-5 text-zinc-500">
          注意：スケジュール登録と正常稼働は別です。外部サービスの認証エラー、在庫・仕入先条件、公開条件によって処理が失敗または保留になることがあります。
        </p>
      </section>

      <section className="mt-8 border border-amber-300/20 p-5" aria-labelledby="missing-controls-heading">
        <h2 id="missing-controls-heading" className="text-base text-amber-200">まだ追加が必要な管理機能</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-zinc-400">
          <li>安全確認付きのBOT停止・再開操作と、変更履歴</li>
          <li>公開・仕入れ・利益率ルールを一元管理し、どの処理がそのルールを使うかを表示する画面</li>
        </ul>
      </section>
    </main>
  );
}

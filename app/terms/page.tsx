import Link from "next/link";

export const metadata = {
  title: "利用規約",
  description: "TRACERの利用条件、商品情報、第三者サービスに関する規約。",
  alternates: { canonical: "/terms" },
  openGraph: { title: "利用規約", description: "TRACERの利用規約", url: "https://tracer-pied-alpha.vercel.app/terms", locale: "ja_JP", type: "article" },
};

export default function TermsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12 text-neutral-900 sm:py-16">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-amber-800">LEGAL / TRACER</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-950 sm:text-4xl">利用規約</h1>
      <p className="mt-4 text-sm text-neutral-600">最終更新日：2026年10月25日</p>
      <div className="mt-10 space-y-8 text-sm leading-7 text-neutral-800">
        <section><h2 className="text-xl font-semibold text-neutral-950">1. 本サービスについて</h2><p className="mt-3">TRACERは、商品情報の整理、仕入先・価格・在庫に関する調査、および商品掲載・運用を支援するサービスです。提供機能や取得できる情報は、接続先サービスや各種設定により異なります。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">2. 利用上の遵守事項</h2><p className="mt-3">利用者は、適用される法令、接続先サイト・マーケットプレイスの利用規約、および各アカウントに適用される条件を遵守するものとします。アクセス制限の回避、権限のない情報の取得、第三者サービスへの妨害その他不正な目的で本サービスを利用してはなりません。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">3. 商品情報の正確性</h2><p className="mt-3">商品価格、在庫、送料、配送日数、仕入先情報、商品識別子および掲載可否は変更されることがあります。取得・確認できない情報について、常に正確性や最新性を保証するものではありません。販売・発注など重要な判断の前に、利用者は必要な情報を確認するものとします。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">4. 第三者サービス</h2><p className="mt-3">TRACERは、Shopify、BASE、仕入先その他の第三者サービスと連携する場合があります。各サービスの利用には、それぞれの利用規約、手数料、審査、稼働状況およびポリシーが適用されます。第三者サービスの仕様変更や障害により、連携が遅延・停止する場合があります。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">5. 売上・利益等の保証</h2><p className="mt-3">TRACERは、売上、利益、商品在庫、仕入先による出荷、マーケットプレイスでの掲載承認、または特定の事業成果を保証するものではありません。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">6. 注文と購入契約</h2><p className="mt-3">商品ページから外部の販売サイトへ移動して購入する場合、購入契約、決済、配送、返品・キャンセル等は、購入手続き画面に表示される販売事業者および販売サイトの条件に従います。購入前に販売者情報と各条件をご確認ください。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">7. 規約の変更</h2><p className="mt-3">本規約は、サービス内容や関連法令の変更に応じて更新されることがあります。更新した場合は本ページに改定日を表示します。</p></section>
      </div>
      <Link href="/" className="mt-10 inline-block font-medium text-amber-900 underline underline-offset-4 hover:text-amber-700">← TRACERトップへ戻る</Link>
    </main>
  );
}

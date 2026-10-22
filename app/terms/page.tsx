import Link from "next/link";

export const metadata = { title: "利用規約", description: "TRACERオンラインストアの利用規約。" };

export default function TermsPage() {
  return <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-12 sm:py-16">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">LEGAL</p><h1 className="mt-3 text-3xl font-bold">利用規約</h1><p className="mt-3 text-sm text-neutral-500">最終更新日：2026年10月22日</p>
    <div className="mt-8 space-y-7 text-sm leading-7 text-neutral-700">
      <section><h2 className="text-lg font-semibold text-neutral-900">第1条（適用）</h2><p className="mt-2">本規約は、TRACERが運営するオンラインストアおよび関連サービスの利用条件を定めるものです。利用者は、本規約および商品ページ・注文画面に表示される個別条件を確認のうえ利用するものとします。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">第2条（注文・契約の成立）</h2><p className="mt-2">注文手続きの完了後、注文受付の通知を送信する場合があります。売買契約の成立時点、支払条件、販売価格、送料、引渡時期等は、注文画面および注文確認の案内に表示する条件に従います。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">第3条（商品情報）</h2><p className="mt-2">商品情報、画像、価格、在庫、配送見込みは、仕入先や物流の状況により変更される場合があります。購入前に商品ページと最終確認画面の内容をご確認ください。重要な表示に誤りがある場合は、注文前にお問い合わせください。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">第4条（禁止事項）</h2><p className="mt-2">利用者は、法令違反、第三者の権利侵害、不正アクセス、サービス運営の妨害、虚偽情報の送信、他者になりすます行為などを行ってはなりません。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">第5条（返品・キャンセル）</h2><p className="mt-2">返品、交換、キャンセル、返金は、商品ページ、注文時に表示された条件および<a className="underline" href="/policies/returns">返品・返金ポリシー</a>に従います。法令上認められる権利を本規約によって制限するものではありません。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">第6条（サービスの変更・停止）</h2><p className="mt-2">保守、障害、外部サービスの停止その他やむを得ない事情により、サービスの全部または一部を変更・停止する場合があります。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">第7条（免責）</h2><p className="mt-2">法令により免責が認められない場合を除き、外部サービスや物流の事情による遅延・停止等について、TRACERは合理的な範囲で対応します。消費者に適用される法令上の権利を排除するものではありません。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">第8条（規約の変更・お問い合わせ）</h2><p className="mt-2">必要に応じて本規約を改定し、改定後の内容を本サイトに掲載します。本規約に関するお問い合わせは<a className="underline" href="/contact">お問い合わせフォーム</a>からご連絡ください。</p></section>
    </div><Link href="/" className="mt-10 inline-block underline">トップページへ戻る →</Link>
  </main>;
}
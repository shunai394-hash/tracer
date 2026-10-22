import Link from "next/link";

export const metadata = { title: "プライバシーポリシー", description: "TRACERにおける個人情報の取り扱いについて。" };

export default function PrivacyPage() {
  return <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-12 sm:py-16">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">LEGAL</p><h1 className="mt-3 text-3xl font-bold">プライバシーポリシー</h1><p className="mt-3 text-sm text-neutral-500">最終更新日：2026年10月22日</p>
    <div className="mt-8 space-y-7 text-sm leading-7 text-neutral-700">
      <section><h2 className="text-lg font-semibold text-neutral-900">1. 取得する情報</h2><p className="mt-2">注文・問い合わせの際に、お名前、メールアドレス、注文情報、お問い合わせ内容などを取得する場合があります。サービスの運用・不正防止・改善のため、アクセスログ、端末・ブラウザ情報、閲覧・操作に関する技術情報を取得する場合があります。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">2. 利用目的</h2><p className="mt-2">取得した情報は、注文の受付・決済・配送・返品対応、問い合わせへの回答、本人確認、不正利用の防止、サービスの維持・改善、法令上必要な対応のために利用します。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">3. 第三者への提供・委託</h2><p className="mt-2">注文の履行やサービス運営に必要な範囲で、決済事業者、配送事業者、仕入先、ホスティング・データベース等の業務委託先に情報を提供する場合があります。法令に基づく場合を除き、本人の同意なく目的外の第三者提供は行いません。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">4. 保管と安全管理</h2><p className="mt-2">情報へのアクセスを業務上必要な範囲に制限し、合理的な安全管理措置を講じます。保存期間は利用目的および法令上の要件に応じて定め、不要となった情報は適切な方法で削除または匿名化します。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">5. Cookie等</h2><p className="mt-2">ログイン状態の維持、カート等の機能提供、利用状況の把握や不正防止のためにCookie等を使用する場合があります。ブラウザ設定によりCookieを制限できますが、一部機能が利用できなくなることがあります。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">6. 開示・訂正・削除等の請求</h2><p className="mt-2">保有する個人情報の開示、訂正、利用停止、削除等を希望される場合は、本人確認に必要な情報を添えて<a className="underline" href="/contact">お問い合わせフォーム</a>からご連絡ください。法令上対応できない場合は、その理由をご案内します。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">7. 改定・お問い合わせ</h2><p className="mt-2">本ポリシーは、法令やサービス内容の変更に応じて改定する場合があります。改定内容は本サイトに掲載します。</p></section>
    </div><Link href="/" className="mt-10 inline-block underline">トップページへ戻る →</Link>
  </main>;
}
import Link from "next/link";

export const metadata = {
  title: "プライバシーポリシー",
  description: "TRACERが取り扱う情報、利用目的、第三者サービスとの連携について。",
  alternates: { canonical: "/privacy" },
  openGraph: { title: "プライバシーポリシー", description: "TRACERのプライバシーポリシー", url: "https://tracer-pied-alpha.vercel.app/privacy", locale: "ja_JP", type: "article" },
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12 text-neutral-900 sm:py-16">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-amber-800">LEGAL / TRACER</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-950 sm:text-4xl">プライバシーポリシー</h1>
      <p className="mt-4 text-sm text-neutral-600">最終更新日：2026年10月25日</p>
      <div className="mt-10 space-y-8 text-sm leading-7 text-neutral-800">
        <section><h2 className="text-xl font-semibold text-neutral-950">1. 取り扱う情報</h2><p className="mt-3">TRACERのサービスや拡張機能を利用する際、機能に応じて商品ページURL、商品識別子、商品名、ブランド、価格、画像URL、取得日時、アカウント情報、連携処理の実行結果などを取り扱う場合があります。実際に取得する情報は、利用する機能と利用者の設定によって異なります。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">2. 利用目的</h2><p className="mt-3">取り扱う情報は、商品情報の照合・整理、価格や在庫の確認、商品掲載・注文処理の支援、サービスの保守・不正利用防止、お問い合わせへの対応、および機能改善のために利用します。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">3. 第三者サービスとの連携</h2><p className="mt-3">利用者が連携を設定した場合、処理に必要な情報がSupabase、Vercel、Shopify、BASE、仕入先その他の連携先サービスに送信・保存されることがあります。各サービス側での情報の取り扱いについては、それぞれのプライバシーポリシーもご確認ください。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">4. 認証情報の管理</h2><p className="mt-3">サーバー用の認証情報や秘密鍵は、公開ページやブラウザ側のコードに含めない運用を基本とします。利用者は、管理トークンやアカウントの認証情報を第三者に共有しないよう管理してください。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">5. 保存・安全管理</h2><p className="mt-3">情報へのアクセスを必要な範囲に制限し、安全管理に努めます。ただし、インターネットを介した送信や保存について、完全な安全性を保証することはできません。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">6. 開示・削除等のお問い合わせ</h2><p className="mt-3">個人情報や保存データに関するお問い合わせは、TRACERの運営者が案内するサポート窓口へご連絡ください。本人確認や法令上の要件に応じて対応します。</p></section>
        <section><h2 className="text-xl font-semibold text-neutral-950">7. 本ポリシーの変更</h2><p className="mt-3">法令やサービス内容の変更に応じて本ポリシーを改定することがあります。改定内容と日付は本ページに掲載します。</p></section>
      </div>
      <Link href="/" className="mt-10 inline-block font-medium text-amber-900 underline underline-offset-4 hover:text-amber-700">← TRACERトップへ戻る</Link>
    </main>
  );
}

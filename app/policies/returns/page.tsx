import Link from "next/link";

export const metadata = { title: "返品・返金ポリシー", description: "TRACERの返品・交換・返金について。" };

export default function ReturnsPolicyPage() {
  return <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-12 sm:py-16">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">POLICY</p><h1 className="mt-3 text-3xl font-bold">返品・返金ポリシー</h1><p className="mt-3 text-sm text-neutral-500">最終更新日：2026年10月22日</p>
    <div className="mt-8 space-y-7 text-sm leading-7 text-neutral-700">
      <section><h2 className="text-lg font-semibold text-neutral-900">お客様都合の返品</h2><p className="mt-2">お客様都合の返品・交換は、商品ページおよび注文時に表示された返品条件に従います。返品不可の商品、使用済み商品、付属品・包装を欠く商品などはお受けできない場合があります。購入前に各商品ページの条件をご確認ください。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">破損・誤配送・初期不良</h2><p className="mt-2">商品到着後は速やかに内容をご確認ください。破損、注文と異なる商品、初期不良がある場合は、注文番号、商品名、状態が分かる写真を添えてお問い合わせください。確認のうえ、交換・返金等の対応をご案内します。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">返金方法・期間</h2><p className="mt-2">返金が承認された場合、原則としてご利用の決済方法に応じて処理します。金融機関や決済事業者の処理により、反映までの日数は異なります。個別の返金予定はお問い合わせください。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">返品送料</h2><p className="mt-2">お客様都合の返品送料はお客様負担、誤配送・初期不良など当店の責任による場合は当店負担を原則とします。商品ごとの表示や法令が優先されます。</p></section>
      <p>通信販売の返品に関する法令上の取り扱いについては、<a className="underline" href="https://www.no-trouble.caa.go.jp/what/mailorder/" target="_blank" rel="noreferrer">特定商取引法ガイド</a>もご参照ください。</p>
    </div><Link href="/contact" className="mt-10 inline-block underline">返品・返金について問い合わせる →</Link>
  </main>;
}
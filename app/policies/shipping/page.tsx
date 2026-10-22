import Link from "next/link";

export const metadata = { title: "配送ポリシー", description: "TRACERの配送・発送・追跡について。" };

export default function ShippingPolicyPage() {
  return <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-12 sm:py-16">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">POLICY</p><h1 className="mt-3 text-3xl font-bold">配送ポリシー</h1><p className="mt-3 text-sm text-neutral-500">最終更新日：2026年10月22日</p>
    <div className="mt-8 space-y-7 text-sm leading-7 text-neutral-700">
      <section><h2 className="text-lg font-semibold text-neutral-900">送料・お届け予定</h2><p className="mt-2">送料およびお届け予定日は、商品ページと注文確認画面に表示される条件をご確認ください。商品や配送先、仕入先の出荷状況により異なります。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">発送・追跡</h2><p className="mt-2">発送準備が整い追跡番号が発行された場合、注文確認メールまたはマイページ等でご案内します。追跡情報の反映には時間がかかる場合があります。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">遅延・住所変更</h2><p className="mt-2">天候、物流事情、通関、仕入先の状況等により配送が遅れる場合があります。住所変更をご希望の場合は、発送前であっても対応できない場合があるため、早めにお問い合わせください。</p></section>
      <section><h2 className="text-lg font-semibold text-neutral-900">受け取り・返送</h2><p className="mt-2">住所不備、長期不在、受取拒否などにより返送された場合、再配送費用等が発生することがあります。個別の取り扱いは状況を確認してご案内します。</p></section>
    </div><Link href="/contact" className="mt-10 inline-block underline">配送について問い合わせる →</Link>
  </main>;
}
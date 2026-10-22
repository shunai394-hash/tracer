import Link from "next/link";

export const metadata = { title: "特定商取引法に基づく表記", description: "TRACERの通信販売に関する事業者情報と取引条件。" };

function value(name: string, fallback: string) { return process.env[name]?.trim() || fallback; }

const rows = [
  ["販売事業者", value("TRACER_SELLER_NAME", "【公開前に販売事業者名を設定してください】")],
  ["運営責任者", value("TRACER_SELLER_REPRESENTATIVE", "【公開前に責任者名を設定してください】")],
  ["所在地", value("TRACER_SELLER_ADDRESS", "【公開前に所在地を設定してください】")],
  ["電話番号", value("TRACER_SELLER_PHONE", "【公開前に連絡可能な電話番号を設定してください】")],
  ["メールアドレス", value("TRACER_SELLER_EMAIL", "お問い合わせフォームをご利用ください")],
  ["販売価格", "各商品ページに税込価格を表示します。"],
  ["商品代金以外の必要料金", "送料・手数料が発生する場合は、商品ページおよび注文確認画面に表示します。"],
  ["お支払い方法・時期", "利用可能な方法および決済時期は注文画面に表示します。"],
  ["商品の引渡時期", "各商品ページおよび注文確認画面に表示する発送・配送目安をご確認ください。"],
  ["返品・交換", "返品の可否、期限、条件、送料負担は商品ページおよび返品・返金ポリシーをご確認ください。"],
];

export default function TokushohoPage() {
  const hasRequired = ["TRACER_SELLER_NAME", "TRACER_SELLER_REPRESENTATIVE", "TRACER_SELLER_ADDRESS", "TRACER_SELLER_PHONE"].every((key) => Boolean(process.env[key]?.trim()));
  return <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-12 sm:py-16">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">LEGAL DISCLOSURE</p><h1 className="mt-3 text-3xl font-bold">特定商取引法に基づく表記</h1>
    <p className="mt-4 text-sm leading-6 text-neutral-600">通信販売に関する事業者情報と取引条件を掲載しています。</p>
    {!hasRequired ? <p role="alert" className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-900">販売事業者の情報が未設定です。公開前に Vercel の環境変数 TRACER_SELLER_NAME / TRACER_SELLER_REPRESENTATIVE / TRACER_SELLER_ADDRESS / TRACER_SELLER_PHONE を実際の情報で設定してください。仮の情報を掲載しないため、未設定項目を明示しています。</p> : null}
    <dl className="mt-8 divide-y divide-neutral-200 border-y border-neutral-200">{rows.map(([label, content]) => <div key={label} className="grid gap-1 py-4 sm:grid-cols-[12rem_1fr] sm:gap-5"><dt className="text-sm font-semibold">{label}</dt><dd className="whitespace-pre-wrap text-sm leading-6 text-neutral-700">{content}</dd></div>)}</dl>
    <p className="mt-8 text-sm leading-6 text-neutral-600">表示内容は実際の販売条件に合わせて確認・更新してください。</p><Link href="/contact" className="mt-6 inline-block underline">お問い合わせ →</Link>
  </main>;
}
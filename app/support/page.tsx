import Link from "next/link";
import { SupportChat } from "@/components/support-chat";

export const metadata = { title: "サポート", description: "TRACERの注文・配送・返品などのお問い合わせ窓口。" };

export default function SupportPage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-10 sm:py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">TRACER CUSTOMER CARE</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">サポートセンター</h1>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-neutral-600">注文、配送、商品、返品・返金に関するご質問はこちらから。チャットで解決しない場合は、担当者へお問い合わせいただけます。</p>
      <div className="mt-8"><SupportChat /></div>
      <section className="mt-10 grid gap-4 sm:grid-cols-2">
        <Link href="/contact" className="rounded-xl border border-neutral-200 p-5 hover:border-neutral-500"><h2 className="font-semibold">お問い合わせフォーム</h2><p className="mt-2 text-sm leading-6 text-neutral-600">内容を送信すると管理画面の問い合わせ一覧に保存されます。</p><span className="mt-4 inline-block text-sm font-semibold underline">フォームを開く →</span></Link>
        <Link href="/shop" className="rounded-xl border border-neutral-200 p-5 hover:border-neutral-500"><h2 className="font-semibold">商品・注文を確認</h2><p className="mt-2 text-sm leading-6 text-neutral-600">商品詳細とマイページから注文情報をご確認ください。</p><span className="mt-4 inline-block text-sm font-semibold underline">商品一覧へ →</span></Link>
      </section>
    </main>
  );
}
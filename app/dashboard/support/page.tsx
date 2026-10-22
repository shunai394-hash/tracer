import { SupportInbox } from "@/components/support-inbox";

export const dynamic = "force-dynamic";
export const metadata = { title: "お問い合わせ管理 — TRACER" };

export default function DashboardSupportPage() {
  return <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-10 sm:py-14">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">ADMIN · CUSTOMER CARE</p>
    <h1 className="mt-3 text-3xl font-bold">お問い合わせ管理</h1>
    <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-600">お客様から送信された問い合わせを一覧・詳細表示し、未対応／対応中／解決済み／迷惑メールを管理します。個人情報を保護するため、管理トークンで認証します。</p>
    <div className="mt-8"><SupportInbox /></div>
  </main>;
}
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist } from "next/font/google";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const viewport: Viewport = { themeColor: "#ffffff", colorScheme: "light" };
export const metadata: Metadata = {
  metadataBase: new URL("https://tracer-pied-alpha.vercel.app"),
  title: { default: "TRACER｜日本向けセレクトショップ", template: "%s｜TRACER" },
  description: "日本のお客様向けに、商品情報・価格・在庫を確認して選べるオンラインストア。商品ごとの仕様を確認してお買い物いただけます。",
  applicationName: "TRACER", alternates: { canonical: "/" },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 } },
  icons: { icon: "/icon.svg", apple: "/icon.svg" }, manifest: "/manifest.webmanifest",
  openGraph: { title: "TRACER｜日本向けセレクトショップ", description: "商品情報・価格・在庫を確認して選べるオンラインストア。", url: "https://tracer-pied-alpha.vercel.app/", siteName: "TRACER", type: "website", locale: "ja_JP" },
  twitter: { card: "summary_large_image", title: "TRACER｜日本向けセレクトショップ", description: "商品情報・価格・在庫を確認して選べるオンラインストア。" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" className={geistSans.variable + " h-full antialiased"}>
      <body className="min-h-full flex flex-col bg-white text-neutral-900">
        <a href="#main-content" className="fixed left-4 top-4 z-[100] -translate-y-24 rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white focus:translate-y-0">本文へ移動</a>
        <SiteHeader />
        <div id="main-content" className="flex flex-1 flex-col">{children}</div>
        <footer className="mt-auto border-t border-neutral-200 bg-white">
          <div className="mx-auto flex max-w-6xl flex-col gap-5 px-5 py-8 text-sm text-neutral-600">
            <div className="flex flex-wrap items-center justify-between gap-3"><span className="font-semibold text-neutral-900">TRACER</span><span className="text-xs">商品・注文に関するご案内</span></div>
            <nav aria-label="フッターメニュー" className="flex flex-wrap gap-x-5 gap-y-3">
              <a href="/support" className="hover:text-neutral-900">サポートセンター</a><a href="/contact" className="hover:text-neutral-900">お問い合わせ</a>
              <a href="/policies/returns" className="hover:text-neutral-900">返品・返金ポリシー</a><a href="/policies/shipping" className="hover:text-neutral-900">配送ポリシー</a>
              <a href="/tokushoho" className="hover:text-neutral-900">特定商取引法に基づく表記</a><a href="/terms" className="hover:text-neutral-900">利用規約</a>
              <a href="/privacy" className="hover:text-neutral-900">プライバシーポリシー</a><a href="/mypage" className="hover:text-neutral-900">マイページ</a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
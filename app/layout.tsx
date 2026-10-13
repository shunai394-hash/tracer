import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist } from "next/font/google";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
};

export const metadata: Metadata = {
  title: "TRACER — 商品一覧",
  description: "商品を探して、内容を確認し、購入する。シンプルなオンラインストア。",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "TRACER — 商品一覧",
    description: "商品を探して、内容を確認し、購入する。",
    type: "website",
    locale: "ja_JP",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" className={geistSans.variable + " h-full antialiased"}>
      <body className="min-h-full flex flex-col bg-white text-neutral-900">
        <a href="#main-content" className="fixed left-4 top-4 z-[100] -translate-y-24 rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white focus:translate-y-0">
          本文へ移動
        </a>
        <SiteHeader />
        <div id="main-content" className="flex flex-1 flex-col">{children}</div>
        <footer className="mt-auto border-t border-neutral-200 bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm text-neutral-500">
            <span className="font-semibold text-neutral-800">TRACER</span>
            <nav aria-label="フッターメニュー" className="flex flex-wrap gap-4">
              <a href="/privacy" className="hover:text-neutral-900">プライバシー</a>
              <a href="/terms" className="hover:text-neutral-900">利用規約</a>
              <a href="/mypage" className="hover:text-neutral-900">マイページ</a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}

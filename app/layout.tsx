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
  metadataBase: new URL((process.env.NEXT_PUBLIC_SITE_URL || "https://tracer-pied-alpha.vercel.app").replace(/\/$/, "")),
  title: {
    default: "TRACER | 日本向けセレクトショップ",
    template: "%s | TRACER",
  },
  description: "日本のお客様向けに、商品情報・価格・在庫を確認して選べるオンラインストア。商品ごとの仕様を確認してお買い物いただけます。",
  applicationName: "TRACER",
  alternates: { canonical: "/" },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 },
  },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "TRACER | 日本向けセレクトショップ",
    description: "商品情報・価格・在庫を確認して選べるオンラインストア。",
    url: (process.env.NEXT_PUBLIC_SITE_URL || "https://tracer-pied-alpha.vercel.app").replace(/\/$/, "") + "/",
    siteName: "TRACER",
    type: "website",
    locale: "ja_JP",
  },
  twitter: {
    card: "summary_large_image",
    title: "TRACER | 日本向けセレクトショップ",
    description: "商品情報・価格・在庫を確認して選べるオンラインストア。",
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

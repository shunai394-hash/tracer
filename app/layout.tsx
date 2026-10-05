import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { SiteHeader } from "@/components/site-header";
import { TracerChat } from "@/components/tracer-chat";
import "./globals.css";
import "./tracer-award.css";
import "./tracer-award-pass4.css";
import "./tracer-award-pass5.css";
import "./tracer-award-pass6.css";
import "./tracer-award-pass7.css";
import "./tracer-award-pass8.css";
import "./tracer-award-pass9.css";
import "./tracer-award-pass10.css";
import "./tracer-award-pass11.css";
import "./tracer-award-pass12.css";
import "./tracer-award-pass13.css";
import "./tracer-award-pass14.css";
import "./tracer-award-pass15.css";
import "./tracer-award-pass16.css";
import "./tracer-editorial-pass2.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
export const viewport: Viewport = { themeColor: "#05070a", colorScheme: "dark" };
export const metadata: Metadata = { title: "TRACER — 気になる商品を、確かめる。", description: "市場の変化から商品・仕入れ・販売条件まで確かめ、次に試す商品を見つけるAIコマースインテリジェンス。", icons: { icon: "/icon.svg", apple: "/icon.svg" }, manifest: "/manifest.webmanifest", openGraph: { title: "TRACER — 気になる商品を、確かめる。", description: "探す、比べる、確かめる。次に試す商品を、理由を持って見つける。", type: "website", locale: "ja_JP" } };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="ja" className={geistSans.variable + " " + geistMono.variable + " h-full antialiased"}><body className="min-h-full flex flex-col bg-background text-foreground"><a href="#main-content" className="fixed left-4 top-4 z-[100] -translate-y-24 bg-cyan-300 px-4 py-2 text-xs font-semibold text-zinc-950 shadow-2xl transition-transform focus:translate-y-0">本文へ移動</a><SiteHeader /><div id="main-content" className="flex flex-1 flex-col">{children}</div><TracerChat /><footer className="border-t border-white/10 bg-black/40"><div className="mx-auto grid w-full max-w-[1440px] gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[1fr_auto] lg:px-10"><div><p className="font-mono text-[11px] tracking-[0.28em] text-zinc-200">TRACER</p><p className="mt-2 max-w-md text-xs leading-6 text-zinc-400">気になる商品を、確かめる。発見から検証、販売テストまでを一つの循環につなぎます。</p></div><nav className="flex flex-wrap items-start gap-x-5 gap-y-2 text-xs text-zinc-400" aria-label="Footer navigation"><a href="/extension" className="transition hover:text-cyan-200">商品を送る</a><a href="/privacy" className="transition hover:text-cyan-200">プライバシー</a><a href="/terms" className="transition hover:text-cyan-200">利用規約</a><a href="/mypage" className="transition hover:text-cyan-200">マイページ</a></nav></div></footer></body></html>; }
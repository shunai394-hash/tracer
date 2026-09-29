import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { SiteHeader } from "@/components/site-header";
import { TracerChat } from "@/components/tracer-chat";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TRACER — AI Commerce Intelligence",
  description:
    "Track products, brands, prices, demand, and supply across world markets.",
  icons: {
    icon: "/icon",
    apple: "/apple-icon",
  },
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="ja"
      className={geistSans.variable + " " + geistMono.variable + " h-full antialiased"}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <SiteHeader />
        <div className="flex flex-1 flex-col">{children}</div>
        <TracerChat />
        <footer className="border-t border-white/10 bg-black/40">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-5 text-xs text-zinc-500">
            <span>TRACER — AI Commerce Intelligence</span>
            <nav className="flex gap-4">
              <a href="/extension" className="hover:text-zinc-200">Extension</a>
              <a href="/privacy" className="hover:text-zinc-200">Privacy</a>
              <a href="/terms" className="hover:text-zinc-200">Terms</a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}

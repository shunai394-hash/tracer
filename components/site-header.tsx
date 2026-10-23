"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SiteHeader() {
  const pathname = usePathname();
  const isStore = pathname.startsWith("/shop");

  return (
    <header className="sticky top-0 z-40 border-b border-[#EADBD3] bg-[#FBF6F1]/95 backdrop-blur">
      <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-4 px-5">
        <Link href="/" className="font-serif text-xl tracking-[0.2em] text-[#3B241A]">TRACER</Link>
        <nav aria-label="メインメニュー" className="flex items-center gap-4 text-sm sm:gap-6">
          <Link href="/shop" className={isStore ? "font-semibold text-[#3B241A]" : "text-[#5C4035] hover:text-[#3B241A]"}>商品一覧</Link>
          <Link href="/shop?cat=bags" className="hidden text-[#5C4035] hover:text-[#3B241A] md:inline">バッグ</Link>
          <Link href="/shop?cat=hair" className="hidden text-[#5C4035] hover:text-[#3B241A] md:inline">ヘアアクセサリー</Link>
          <Link href="/shop/cart" className="text-[#5C4035] hover:text-[#3B241A]">カート</Link>
          <Link href="/mypage" className="hidden text-[#5C4035] hover:text-[#3B241A] sm:inline">マイページ</Link>
        </nav>
      </div>
    </header>
  );
}

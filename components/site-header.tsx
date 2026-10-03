"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const discoveryLinks = [
  { href: "/bestsellers", label: "市場" },
  { href: "/intelligence", label: "商機" },
  { href: "/demand", label: "需要" },
  { href: "/extension", label: "商品を送る" },
] as const;

const utilityLinks = [
  { href: "/dashboard", label: "運用" },
  { href: "/products", label: "商品管理" },
  { href: "/orders", label: "注文" },
  { href: "/settings", label: "設定" },
] as const;

const shopLinks = [
  { href: "/shop", label: "商品" },
  { href: "/shop/cart", label: "カート" },
  { href: "/shop/checkout", label: "購入手続き" },
] as const;

function NavLink({ href, label, pathname }: { href: string; label: string; pathname: string }) {
  const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`whitespace-nowrap border-b px-1 py-1 transition-colors ${active ? "border-cyan-300 text-cyan-200" : "border-transparent text-zinc-500 hover:text-zinc-200"}`}
    >
      {label}
    </Link>
  );
}

export function SiteHeader() {
  const pathname = usePathname();
  const shop = pathname.startsWith("/shop");

  if (shop) {
    return (
      <header className="sticky top-0 z-20 border-b border-white/10 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto max-w-7xl px-5 py-3 sm:px-8">
          <div className="flex items-center justify-between gap-5">
            <Link href="/shop" className="shrink-0 text-base font-medium tracking-[0.22em] text-zinc-100 sm:text-lg">
              TRACER STORE
            </Link>
            <nav aria-label="Store navigation" className="flex min-w-0 items-center gap-5 overflow-x-auto text-sm">
              {shopLinks.map((link) => <NavLink key={link.href} {...link} pathname={pathname} />)}
            </nav>
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-[#07090b]/90 backdrop-blur-xl">
      <div className="mx-auto max-w-7xl px-5 py-3 sm:px-8">
        <div className="flex items-center justify-between gap-5">
          <Link href="/" className="flex shrink-0 items-baseline gap-3">
            <span className="font-mono text-lg tracking-[0.35em] text-cyan-300">TRACER</span>
            <span className="hidden text-xs tracking-[0.16em] text-zinc-600 lg:inline">気になる商品を、確かめる。</span>
          </Link>
          <Link href="/shop" className="shrink-0 border border-cyan-400/30 bg-cyan-400/[0.03] px-4 py-2.5 text-[10px] font-medium tracking-[0.16em] text-cyan-200 transition hover:border-cyan-300/60 hover:bg-cyan-300/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
            商品を見る
          </Link>
        </div>

        <div className="mt-3 flex items-center justify-between gap-5">
          <nav aria-label="Main navigation" className="-mx-1 flex gap-5 overflow-x-auto pb-1 text-[11px] tracking-[0.13em]">
            {discoveryLinks.map((link) => <NavLink key={link.href} {...link} pathname={pathname} />)}
          </nav>
          <nav aria-label="Operations navigation" className="hidden shrink-0 items-center gap-4 border-l border-white/8 pl-4 text-[10px] lg:flex">
            {utilityLinks.map((link) => <NavLink key={link.href} {...link} pathname={pathname} />)}
          </nav>
        </div>
      </div>
    </header>
  );
}

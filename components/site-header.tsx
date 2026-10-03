"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const intelLinks = [
  { href: "/", label: "発見" },
  { href: "/bestsellers", label: "世界の動き" },
  { href: "/intelligence", label: "なぜ注目？" },
  { href: "/demand", label: "需要" },
  { href: "/shop", label: "商品" },
  { href: "/extension", label: "取り込む" },
  { href: "/dashboard", label: "管理" },
  { href: "/chat", label: "AIに聞く" },
  { href: "/products", label: "商品データ" },
  { href: "/orders", label: "注文" },
  { href: "/sources", label: "情報源" },
  { href: "/settings", label: "設定" },
] as const;

const shopLinks = [
  { href: "/shop", label: "商品" },
  { href: "/shop/cart", label: "カート" },
  { href: "/shop/checkout", label: "購入手続き" },
] as const;

function NavLink({
  href,
  label,
  pathname,
}: {
  href: string;
  label: string;
  pathname: string;
}) {
  const active =
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`whitespace-nowrap border-b px-1 py-1 transition-colors ${
        active
          ? "border-cyan-300 text-cyan-200"
          : "border-transparent text-zinc-500 hover:text-zinc-200"
      }`}
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
        <div className="mx-auto max-w-6xl px-6 py-3">
          <div className="flex items-center justify-between gap-6">
            <Link href="/shop" className="shrink-0 text-lg tracking-[0.2em] text-zinc-100">
              TRACER STORE
            </Link>
            <nav
              aria-label="ストアナビゲーション"
              className="flex min-w-0 items-center gap-5 overflow-x-auto text-sm"
            >
              {shopLinks.map((link) => (
                <NavLink key={link.href} {...link} pathname={pathname} />
              ))}
            </nav>
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-20 border-b border-cyan-500/20 bg-black/85 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-5">
          <Link href="/" className="flex shrink-0 items-baseline gap-3">
            <span className="font-mono text-lg tracking-[0.35em] text-cyan-300">
              TRACER
            </span>
            <span className="hidden text-xs tracking-[0.18em] text-zinc-500 lg:inline">
              WORLD PRODUCT DISCOVERY
            </span>
          </Link>

          <Link
            href="/shop"
            className="shrink-0 border border-cyan-400/30 px-3 py-2 text-[10px] tracking-[0.12em] text-cyan-200 transition hover:bg-cyan-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
          >
            見つける
          </Link>
        </div>

        <nav
          aria-label="メインナビゲーション"
          className="-mx-1 mt-3 flex gap-4 overflow-x-auto pb-1 text-[11px] tracking-[0.08em]"
        >
          {intelLinks.map((link) => (
            <NavLink key={link.href} {...link} pathname={pathname} />
          ))}
        </nav>
      </div>
    </header>
  );
}

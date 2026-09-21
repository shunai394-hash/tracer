"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const intelLinks = [
  { href: "/", label: "World" },
  { href: "/shop", label: "Shop" },
  { href: "/bestsellers", label: "Bestsellers" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/intelligence", label: "Opportunities" },
  { href: "/demand", label: "Demand" },
  { href: "/chat", label: "Chat" },
  { href: "/products", label: "Products" },
  { href: "/orders", label: "Orders" },
  { href: "/sources", label: "Sources" },
  { href: "/settings", label: "Settings" },
] as const;

const shopLinks = [
  { href: "/shop", label: "商品" },
  { href: "/shop/cart", label: "カート" },
  { href: "/shop/checkout", label: "購入手続き" },
] as const;

export function SiteHeader() {
  const pathname = usePathname();
  const shop = pathname.startsWith("/shop");

  if (shop) {
    return (
      <header className="sticky top-0 z-20 border-b border-white/10 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/shop" className="text-lg tracking-[0.2em] text-zinc-100">
            TRACER STORE
          </Link>
          <nav className="flex items-center gap-5 text-sm text-zinc-400">
            {shopLinks.map((link) => (
              <Link key={link.href} href={link.href} className="hover:text-zinc-100">
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-20 border-b border-cyan-500/20 bg-black/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-baseline gap-3">
          <span className="font-mono text-lg tracking-[0.35em] text-cyan-300">
            TRACER
          </span>
          <span className="hidden text-xs uppercase tracking-[0.22em] text-zinc-500 sm:inline">
            AI Commerce Intelligence
          </span>
        </Link>
        <nav className="flex flex-wrap items-center gap-4 text-xs uppercase tracking-[0.16em] text-zinc-400">
          {intelLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="transition-colors hover:text-cyan-200"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

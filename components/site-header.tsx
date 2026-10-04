"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const discoveryLinks = [
  { href: "/bestsellers", label: "市場", meta: "MARKET" },
  { href: "/intelligence", label: "商機", meta: "OPPORTUNITY" },
  { href: "/demand", label: "需要", meta: "DEMAND" },
  { href: "/extension", label: "商品を送る", meta: "CAPTURE" },
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

function SignalMark() {
  return (
    <span className="relative flex h-5 w-5 items-end gap-[2px]" aria-hidden="true">
      <span className="h-2 w-px bg-cyan-300/45" />
      <span className="h-3.5 w-px bg-cyan-300/70" />
      <span className="h-5 w-px bg-cyan-200" />
      <span className="absolute -right-0.5 top-0 h-1.5 w-1.5 rounded-full bg-cyan-200 shadow-[0_0_12px_rgba(103,232,249,0.9)]" />
    </span>
  );
}

function NavLink({ href, label, pathname, meta }: { href: string; label: string; pathname: string; meta?: string }) {
  const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`group relative flex shrink-0 items-center gap-2 py-2 text-[10px] tracking-[0.13em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300 ${
        active ? "text-cyan-100" : "text-zinc-500 hover:text-zinc-100"
      }`}
    >
      {active && <span className="h-1 w-1 rounded-full bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.9)]" aria-hidden="true" />}
      <span>{label}</span>
      {meta && <span className="hidden text-[7px] tracking-[0.18em] text-zinc-700 transition-colors group-hover:text-zinc-500 xl:inline">{meta}</span>}
      <span className={`absolute inset-x-0 -bottom-px h-px origin-left bg-cyan-300 transition-transform duration-300 ${active ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"}`} aria-hidden="true" />
    </Link>
  );
}

function AccountLink({ pathname }: { pathname: string }) {
  return <NavLink href="/mypage" label="マイページ" pathname={pathname} meta="ACCOUNT" />;
}

export function SiteHeader() {
  const pathname = usePathname();
  const shop = pathname.startsWith("/shop");

  if (shop) {
    return (
      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#07090b]/92 backdrop-blur-2xl">
        <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-10">
          <div className="flex min-h-14 items-center justify-between gap-5">
            <Link href="/shop" className="group flex shrink-0 items-center gap-3" aria-label="TRACER Store home">
              <SignalMark />
              <span className="font-mono text-[15px] tracking-[0.28em] text-zinc-100 transition-colors group-hover:text-cyan-200">TRACER</span>
              <span className="h-3 w-px bg-white/15" aria-hidden="true" />
              <span className="text-[9px] tracking-[0.22em] text-zinc-600">STORE</span>
            </Link>
            <nav aria-label="Store navigation" className="tracer-nav-scroll flex min-w-0 items-center gap-5 overflow-x-auto">
              {shopLinks.map((link) => <NavLink key={link.href} {...link} pathname={pathname} />)}
              <AccountLink pathname={pathname} />
            </nav>
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-40 border-b border-white/8 bg-[#07090b]/88 backdrop-blur-2xl">
      <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-10">
        <div className="flex min-h-16 items-center justify-between gap-6">
          <Link href="/" className="group flex shrink-0 items-center gap-3" aria-label="TRACER home">
            <SignalMark />
            <span className="relative font-mono text-[17px] tracking-[0.32em] text-cyan-300 transition-colors group-hover:text-cyan-100">TRACER</span>
            <span className="hidden h-4 w-px bg-white/10 sm:block" aria-hidden="true" />
            <span className="hidden text-[9px] tracking-[0.2em] text-zinc-600 sm:block">AI COMMERCE INTELLIGENCE</span>
          </Link>

          <div className="flex items-center gap-3 sm:gap-5">
            <span className="hidden items-center gap-2 text-[8px] font-mono tracking-[0.18em] text-zinc-600 lg:flex" aria-label="TRACER system">
              <span className="tracer-signal-pulse h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.8)]" aria-hidden="true" />
              TRACER SYSTEM
            </span>
            <Link href="/mypage" className="hidden text-[9px] font-semibold tracking-[0.14em] text-zinc-400 transition hover:text-cyan-200 sm:inline-flex">マイページ</Link>
            <Link href="/shop" className="group inline-flex min-h-10 items-center gap-3 border border-cyan-300/25 bg-cyan-300/[0.035] px-4 text-[9px] font-semibold tracking-[0.16em] text-cyan-100 transition duration-300 hover:-translate-y-px hover:border-cyan-200/60 hover:bg-cyan-200/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-200">
              商品を見る
              <span className="transition-transform duration-300 group-hover:translate-x-0.5" aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>

        <div className="flex min-h-10 items-center justify-between gap-5 border-t border-white/[0.045]">
          <nav aria-label="Main navigation" className="tracer-nav-scroll -mx-1 flex min-w-0 gap-5 overflow-x-auto">
            {discoveryLinks.map((link) => <NavLink key={link.href} {...link} pathname={pathname} />)}
          </nav>
          <nav aria-label="Operations navigation" className="hidden shrink-0 items-center gap-4 border-l border-white/8 pl-5 lg:flex">
            {utilityLinks.map((link) => <NavLink key={link.href} {...link} pathname={pathname} />)}
            <AccountLink pathname={pathname} />
          </nav>
        </div>
      </div>
    </header>
  );
}

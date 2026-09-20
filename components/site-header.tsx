import Link from "next/link";

const links = [
  { href: "/", label: "World" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/intelligence", label: "Opportunities" },
  { href: "/products", label: "Products" },
  { href: "/sources", label: "Sources" },
  { href: "/settings", label: "Settings" },
] as const;

export function SiteHeader() {
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
          {links.map((link) => (
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
